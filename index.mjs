import layerUtils from "/opt/nodejs/utils.js";
import LayerConstants from "/opt/nodejs/Constants.js";
import knex from "/opt/nodejs/db.js";
import DatabaseTableConstants from "/opt/nodejs/DatabaseTableConstants.js";
import { OAuth2Client } from "google-auth-library";
import axios from "axios";

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

const normalize = (val) => {
    if (val === undefined || val === null) return null;
    if (val instanceof Date) return val.toISOString();
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) return new Date(val).toISOString();
    return val;
};


export const handler = async (event) => {
  // TODO implement
  const response = {
    statusCode: 200,
    body: JSON.stringify('Hello from Lambda!'),
  };
  return response;
};
