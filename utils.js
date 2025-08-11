import LayerConstants from "/opt/nodejs/Constants.js";
import knex from "/opt/nodejs/db.js";
import SnsUtils from "/opt/nodejs/SnsUtils.js";
import DatabaseTableConstants from "/opt/nodejs/DatabaseTableConstants.js";
import { S3Client, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import axios from "axios";

const s3Client = new S3Client({ region: "us-east-2" });

class Utils {
    static getLocalPostCreateUrl(accountId, locationId) {
        return `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`;
    }

    static async fetchPostFromDatabase(post_id, gmb_id) {
        const postData = await knex(DatabaseTableConstants.GMB_POST_TABLE)
            .where({ id: post_id, gmb_id })
            .first();
        
        if (!postData) {
            throw new Error(`Post not found: ${post_id}`);
        }
        
        return postData;
    }

    static async fetchMediaFromDatabase(post_id, gmb_id) {
        const mediaData = await knex(DatabaseTableConstants.GMB_MEDIA_TABLE)
            .where({ post_id, gmb_id });
        
        return mediaData || [];
    }

    static async createLocalPostInstance(postData, mediaData, gmb_id) {
        const {
            languageCode,
            summary,
            callToAction_url,
            callToAction_type,
            event_title,
            event_schedule,
            topicType,
            alertType,
            offer_couponCode,
            offer_redeemOnlineUrl,
            offer_termsConditions,
        } = postData;

        const localPostInstance = {
            postType: topicType,
            languageCode: languageCode || "en-US",
            summary: summary || "",
        };

        if (topicType !== "OFFER" && callToAction_type !== undefined) {
            localPostInstance.callToAction = {
                type: callToAction_type,
                url: callToAction_url || "",
            };
        }

        if (topicType === "EVENT" || topicType === "OFFER") {
            localPostInstance.event = {
                title: event_title,
                schedule: event_schedule,
            };
        }

        if (topicType === "ALERT") {
            localPostInstance.alertType = alertType;
        }

        if (topicType === "OFFER") {
            localPostInstance.offer = {
                couponCode: offer_couponCode || "",
                redeemOnlineUrl: offer_redeemOnlineUrl || "",
                termsConditions: offer_termsConditions || "",
            };
        }

        // Handle media with presigned URLs
        let uploadedFiles = [];
        if (mediaData && mediaData.length > 0) {
            const mediaWithUrls = await Promise.all(
                mediaData.map(async (media) => {
                    const key = `${gmb_id}/${media.id}`;
                    const signedUrl = await Utils.getSignedUrlForS3Object(key);
                    return {
                        sourceUrl: signedUrl,
                        contentType: media.contentType,
                        description: media.description || "",
                    };
                })
            );

            localPostInstance.media = mediaWithUrls;
            uploadedFiles = mediaData.map(media => ({
                key: `${gmb_id}/${media.id}`,
                fileName: media.fileName,
                contentType: media.contentType
            }));
        }

        return { localPostInstance, uploadedFiles };
    }

    // Create post via Google API
    static async createLocalPost(accountId, locationId, localPostInstance, googleAccessToken) {
        const locationPostCreateUrl = Utils.getLocalPostCreateUrl(accountId, locationId);

        const postRes = await axios.post(locationPostCreateUrl, localPostInstance, {
            headers: {
                Authorization: `Bearer ${googleAccessToken}`,
            },
        });
        
        return postRes.data;
    }

    static async getSignedUrlForS3Object(key, bucketName = LayerConstants.GMB_MEDIA_BUCKET) {
        try {
            const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
            const signedUrl = await getSignedUrl(
                s3Client,
                command,
                { expiresIn: LayerConstants.PRE_SIGNED_URL_EXPIRY_TIME || 3600 }
            );
            return signedUrl;
        } catch (error) {
            throw new Error(`Failed to get signed URL for S3 object: ${error.message}`);
        }
    }

    static async updatePostInDatabase(trx, gmb_id, post_id, post) {
        try {
            await trx(DatabaseTableConstants.GMB_POST_TABLE)
                .where({ id: post_id, gmbId: gmb_id })
                .update({
                    id: post.name.split("/").pop(),
                    languageCode: post.languageCode ?? null,
                    summary: post.summary ?? null,
                    callToAction_url: post.callToAction?.url ?? null,
                    callToAction_type: post.callToAction?.actionType ?? null,
                    createTime: post.createTime ?? null,
                    updateTime: post.updateTime ?? null,
                    event_title: post.event?.title ?? null,
                    event_schedule: post.event?.schedule ?? null,
                    state: post.state ?? null,
                    searchUrl: post.searchUrl ?? null,
                    topicType: post.topicType ?? null,
                    alertType: post.alertType ?? null,
                    offer_couponCode: post.offer?.couponCode ?? null,
                    offer_redeemOnlineUrl: post.offer?.redeemOnlineUrl ?? null,
                    offer_termsConditions: post.offer?.termsConditions ?? null,
                    scheduled_pub_time: null,
                });
        } catch (error) {
            throw new Error(`Failed to update post in database: ${error.message}`);
        }
    }

    static async cleanupOldMedia(trx, gmb_id, post_id, existingMedia) {
        if (!existingMedia || existingMedia.length === 0) {
            return;
        }

        try {
            // Delete from S3
            const existingMediaKeys = existingMedia.map((m) => ({ key: `${gmb_id}/${m.id}` }));
            await Utils.removeDocumentsFromS3(existingMediaKeys);

            // Delete from database
            await trx(DatabaseTableConstants.GMB_MEDIA_TABLE)
                .where({ gmb_id, post_id })
                .del();
        } catch (error) {
            throw new Error(`Failed to cleanup old media: ${error.message}`);
        }
    }

    static async saveNewMedia(trx, gmb_id, post_id, media) {
        try {
            const rows = media.map(m => ({
                gmb_id:              gmb_id,
                post_id:             post_id || null,
                name:                m.name,
                media_format:        m.mediaFormat,
                category:            m.locationAssociation?.category ?? null,
                price_list_item_id:  m.locationAssociation?.priceListItemId ?? null,
                google_url:          m.googleUrl,
                thumbnail_url:       m.thumbnailUrl,
                create_time:         m.createTime,
                // backed_up_time will default to now()
                width_px:            m.dimensions?.widthPixels ?? null,
                height_px:           m.dimensions?.heightPixels ?? null,
                view_count:          m.insights?.viewCount ?? null,
                attribution_json:    m.attribution || null,
                description:         m.description || null,
                source_url:          m.sourceUrl || null,
                data_ref_resource:   m.dataRef?.resourceName || null
            }));
            
            const inserted = await trx(DatabaseTableConstants.GMB_MEDIA_TABLE)
                .insert(rows)
                .returning(['id', 'google_url']);

            await Promise.all(
                inserted.map(async (media) => {
                    const key = `${gmb_id}/${media.id}`;
                    const response = await axios.get(media.google_url, { responseType: 'arraybuffer' });
                    const fileBuffer = response.data;
                    const contentType = response.headers['content-type'];
                    await Utils.uploadMediaToS3(key, fileBuffer, contentType);
                })
            );

        } catch (error) {
            console.error(`Failed to save new media:`, error);
            throw new Error(`Failed to save new media: ${error.message}`);
        }
    }

    static async uploadMediaToS3(key, content, contentType, bucketName = LayerConstants.GMB_MEDIA_BUCKET) {
        try {
            const putObjectCommand = new PutObjectCommand({
                Bucket: bucketName,
                Key: key,
                Body: content,
                ContentType: contentType || "application/octet-stream",
            });

            await s3Client.send(putObjectCommand);
        } catch (error) {
            throw new Error(`Failed to upload media to S3: ${error.message}`);
        }
    }

    static async removeDocumentsFromS3(uploadedFiles, bucketName = LayerConstants.GMB_MEDIA_BUCKET) {
        if (!uploadedFiles || !Array.isArray(uploadedFiles) || uploadedFiles.length === 0) {
            return;
        }

        try {
            const deletePromises = uploadedFiles.map(async (file) => {
                const deleteObjectCommand = new DeleteObjectCommand({
                    Bucket: bucketName,
                    Key: file.key,
                });

                await s3Client.send(deleteObjectCommand);
            });

            await Promise.all(deletePromises);
        } catch (error) {
            throw new Error(`Failed to remove documents from S3: ${error.message}`);
        }
    }

    static async sendEmailNotification(user_id, postData) {
        try {
            const userData = await knex('USER_TABLE')
                .where({ id: user_id })
                .first();

            if (!userData) {
                console.warn(`User not found: ${user_id}`);
                throw new Error(`User not found: ${user_id}`);
            }

            const message = {
                email: userData.email,
                subject: "GMB Post Published Successfully",
                message: `Hello ${userData.name},\n\nYour scheduled Google My Business post has been published successfully.\n\nPost Summary: ${postData.summary}\nPost Type: ${postData.topicType}\nPublished At: ${new Date().toISOString()}\n\nBest regards,\nGMB Post Scheduler`
            };

            await SnsUtils.sendEmailNotificationSns(message);

            console.log(`📧 Email notification sent to: ${userData.email}`);
        } catch (error) {
            console.error(`Failed to send email notification:`, error);
        }
    }
}

export default Utils;
