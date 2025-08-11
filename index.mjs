import layerUtils from "/opt/nodejs/utils.js";
import knex from "/opt/nodejs/db.js";
import DatabaseTableConstants from "/opt/nodejs/DatabaseTableConstants.js";
import { OAuth2Client } from "google-auth-library";
import Utils from "./utils.js";

let googleOAuth2Client;

const initializeGoogleOAuthClient = async () => {
    const clientId = await layerUtils.getGoogleClientId();
    const clientSecret = await layerUtils.getGoogleClientSecret();
    googleOAuth2Client = new OAuth2Client(clientId, clientSecret, "postmessage");
};

const getAccessTokenFromRefreshToken = async (refreshToken) => {
    googleOAuth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await googleOAuth2Client.refreshAccessToken();
    return credentials.access_token;
};

const fetchValidGoogleAccessToken = async (accountId, organizationId) => {
    const googleCred = await knex(DatabaseTableConstants.GOOGLE_CREDENTIALS_TABLE)
        .where({ organization_id: organizationId, sub: accountId })
        .first();

    if (!googleCred) {
        throw new Error(`Missing Google credentials for org ${organizationId}, account ${accountId}`);
    }

    const refreshToken = await layerUtils.decryptGoogleToken(googleCred.google_refresh_token);
    return await getAccessTokenFromRefreshToken(refreshToken);
};

export const handler = async (event) => {
    console.log(`🚀 GMB Post Scheduler Event: ${JSON.stringify(event)}`);
    
    if (!googleOAuth2Client) {
        await initializeGoogleOAuthClient();
    }

    try {
        const { accountId, gmb_id, organizationId, post_id, user_id } = event.detail || event;
        
        if (!post_id || !gmb_id || !accountId || !organizationId) {
            throw new Error('Missing required parameters: accountId, gmb_id, organizationId, post_id');
        }

        console.log(`Fetching Google access token for account ${accountId}`);
        const googleAccessToken = await fetchValidGoogleAccessToken(accountId, organizationId);
        if (!googleAccessToken) {
            throw new Error(`Failed to obtain Google access token for account ${accountId}`);
        }

        console.log(`📝 Processing scheduled post: ${post_id} for GMB: ${gmb_id}`);

        // Step 1: Fetch post data from GMB_POST_TABLE
        const postData = await Utils.fetchPostFromDatabase(post_id, gmb_id);
        
        // Validate post state must be SCHEDULED
        if (postData.state !== 'SCHEDULED') {
            console.warn(`❌ Post ${post_id} is not in SCHEDULED state. Current state: ${postData.state}`);
            return {
                statusCode: 400,
                body: JSON.stringify({
                    message: `Post ${post_id} is not in SCHEDULED state. Current state: ${postData.state}`
                })
            };
        }

        // Step 2: Fetch media data from GMB_MEDIA_TABLE
        console.log(`Fetching media data for post ${post_id} in GMB ${gmb_id}`);
        const mediaData = await Utils.fetchMediaFromDatabase(post_id, gmb_id);

        // Step 3: Create LocalPostCreateInstance with media data
        console.log(`Creating LocalPostCreateInstance for post ${post_id}`);
        const { localPostInstance } = await Utils.createLocalPostInstance(postData, mediaData, gmb_id);

        // Step 4: POST LocalPostCreateInstance to Google API
        console.log(`Posting LocalPostCreateInstance to Google API for post ${post_id}`);
        const uploadedPost = await Utils.createLocalPost(accountId, gmb_id, localPostInstance, googleAccessToken);

        console.log(`✅ Post created successfully:`, uploadedPost.name);

        // Step 5: Update database in transaction
        await knex.transaction(async (trx) => {
            await Utils.updatePostInDatabase(trx, gmb_id, post_id, uploadedPost);

            // Delete previous media from GMB_MEDIA_TABLE and S3
            await Utils.cleanupOldMedia(trx, gmb_id, post_id, mediaData);

            // Save new media from uploadedPost
            if (uploadedPost.media && uploadedPost.media.length > 0) {
                await Utils.saveNewMedia(trx, gmb_id, post_id, uploadedPost.media);
            }
        });
        console.log(`✅ Database updated successfully for post ${post_id}`);

        // Step 6: Send email notification to user
        console.log(`Sending email notification for post ${post_id} to user ${user_id}`);
        if (user_id) {
            await Utils.sendEmailNotification(user_id, postData);
        }

        console.log(`🎉 Successfully processed scheduled post: ${post_id}`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Post scheduled successfully',
                gmbPostName: uploadedPost.name
            })
        };

    } catch (error) {
        console.error(`❌ Error processing scheduled post:`, error);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Failed to process scheduled post',
                error: error.message
            })
        };
    }
};
