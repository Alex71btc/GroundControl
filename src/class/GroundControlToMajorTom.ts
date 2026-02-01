import { fetch } from "undici";
import { GoogleAuth } from "google-auth-library";
import { DataSource } from "typeorm";
import { PushLog } from "../entity/PushLog";
import { TokenToAddress } from "../entity/TokenToAddress";
import { TokenToHash } from "../entity/TokenToHash";
import { TokenToTxid } from "../entity/TokenToTxid";
import { components } from "../openapi/api";
import { StringUtils } from "../utils/stringUtils";

const jwt = require("jsonwebtoken");
const http2 = require("http2");
require("dotenv").config();

if (
  !process.env.APNS_P8 ||
  !process.env.APPLE_TEAM_ID ||
  !process.env.APNS_P8_KID ||
  !process.env.GOOGLE_KEY_FILE ||
  !process.env.GOOGLE_PROJECT_ID
) {
  console.error("not all env variables set");
  process.exit();
}

const auth = new GoogleAuth({
  keyFile: process.env.GOOGLE_KEY_FILE,
  scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
});

/**
 * Transforms pushnotification objects (openapi schema) into the actual payload sent to FCM/APNS.
 */
export class GroundControlToMajorTom {
  protected static _jwtToken: string = "";
  protected static _jwtTokenMicroTimestamp: number = 0;

  static async getGoogleCredentials() {
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    return accessTokenResponse.token;
  }

  static getApnsJwtToken(): string {
    if (+new Date() - GroundControlToMajorTom._jwtTokenMicroTimestamp < 1800 * 1000) {
      return GroundControlToMajorTom._jwtToken;
    }

    const key = Buffer.from(process.env.APNS_P8, "hex").toString("utf8");
    const jwtToken = jwt.sign(
      {
        iss: process.env.APPLE_TEAM_ID,
        iat: Math.round(+new Date() / 1000),
      },
      key,
      {
        header: {
          alg: "ES256",
          kid: process.env.APNS_P8_KID,
        },
      }
    );

    GroundControlToMajorTom._jwtTokenMicroTimestamp = +new Date();
    GroundControlToMajorTom._jwtToken = jwtToken;

    return jwtToken;
  }

  /**
   * Unconfirmed incoming tx on an onchain address (mempool event).
   */
  static async pushOnchainAddressGotUnconfirmedTransaction(
    dataSource: DataSource,
    serverKey: string,
    apnsP8: string,
    pushNotification: components["schemas"]["PushNotificationOnchainAddressGotUnconfirmedTransaction"]
  ): Promise<void> {
    const shortAddr = StringUtils.shortenAddress(pushNotification.address);

    const fcmPayload = {
      message: {
        token: "",
        data: {
          badge: String(pushNotification.badge),
          tag: pushNotification.txid,
        },
        notification: {
          title: "New unconfirmed transaction",
          body: "You received new transfer on " + shortAddr,
        },
        android: {
          notification: {
            // collapse unconfirmed updates for same txid
          tag: pushNotification.txid,
          },
        },
      },
    };

    const apnsPayload: any = {
      aps: {
        badge: pushNotification.badge,
        alert: {
          title: "New Transaction - Pending",
          body: "Received transaction on " + shortAddr,
        },
        sound: "default",
      },
      data: {},
    };

    if (pushNotification.os === "android")
      return GroundControlToMajorTom._pushToFcm(dataSource, serverKey, pushNotification.token, fcmPayload, pushNotification);
    if (pushNotification.os === "ios")
      return GroundControlToMajorTom._pushToApns(dataSource, apnsP8, pushNotification.token, apnsPayload, pushNotification, String((pushNotification as any).txid));
  }

  /**
   * Confirmed txid (block confirmation event).
   */
  static async pushOnchainTxidGotConfirmed(
    dataSource: DataSource,
    serverKey: string,
    apnsP8: string,
    pushNotification: components["schemas"]["PushNotificationTxidGotConfirmed"]
  ): Promise<void> {
    const shortTx = StringUtils.shortenTxid(pushNotification.txid);

    const fcmPayload = {
      message: {
        token: "",
        data: {
          badge: String(pushNotification.badge),
          tag: pushNotification.txid,
        },
        notification: {
          title: "Transaction - Confirmed",
          body: "Your transaction " + shortTx + " has been confirmed",
        },
        android: {
          notification: {
            tag: pushNotification.txid,
          },
        },
      },
    };

    const apnsPayload: any = {
      aps: {
        badge: pushNotification.badge,
        alert: {
          title: "Transaction - Confirmed",
          body: "Your transaction " + shortTx + " has been confirmed",
        },
        sound: "default",
      },
      data: {},
    };

    if (pushNotification.os === "android")
      return GroundControlToMajorTom._pushToFcm(dataSource, serverKey, pushNotification.token, fcmPayload, pushNotification);
    if (pushNotification.os === "ios")
      return GroundControlToMajorTom._pushToApns(dataSource, apnsP8, pushNotification.token, apnsPayload, pushNotification, String((pushNotification as any).txid));
  }

  /**
   * Generic message.
   */
  static async pushMessage(
    dataSource: DataSource,
    serverKey: string,
    apnsP8: string,
    pushNotification: components["schemas"]["PushNotificationMessage"]
  ): Promise<void> {
    const fcmPayload = {
      message: {
        token: "",
        data: {},
        notification: {
          title: "Message",
          body: pushNotification.text,
        },
      },
    };

    const apnsPayload: any = {
      aps: {
        badge: pushNotification.badge,
        alert: {
          title: "Message",
          body: pushNotification.text,
        },
        sound: "default",
      },
      data: {},
    };

    if (pushNotification.os === "android")
      return GroundControlToMajorTom._pushToFcm(dataSource, serverKey, pushNotification.token, fcmPayload, pushNotification);
    if (pushNotification.os === "ios")
      return GroundControlToMajorTom._pushToApns(dataSource, apnsP8, pushNotification.token, apnsPayload, pushNotification, String((pushNotification as any).txid));
  }

  /**
   * Address was paid (usually after confirmation / blockprocessor or a specific event type).
   * This is the nice "+X sats Received on ..." style.
   */
  static async pushOnchainAddressWasPaid(
    dataSource: DataSource,
    serverKey: string,
    apnsP8: string,
    pushNotification: components["schemas"]["PushNotificationOnchainAddressGotPaid"]
  ): Promise<void> {
    const shortAddr = StringUtils.shortenAddress(pushNotification.address);

    const fcmPayload = {
      message: {
        token: "",
        data: {
          badge: String(pushNotification.badge),
          tag: pushNotification.txid,
        },
        notification: {
          title: "+" + pushNotification.sat + " sats",
          body: "Received on " + shortAddr,
        },
        android: {
          notification: {
            tag: pushNotification.txid,
          },
        },
      },
    };

    const apnsPayload: any = {
      aps: {
        badge: pushNotification.badge,
        alert: {
          title: "+" + pushNotification.sat + " sats",
          body: "Received on " + shortAddr,
        },
        sound: "default",
      },
      data: {},
    };

    if (pushNotification.os === "android")
      return GroundControlToMajorTom._pushToFcm(dataSource, serverKey, pushNotification.token, fcmPayload, pushNotification);
    if (pushNotification.os === "ios")
return GroundControlToMajorTom._pushToApns(
  dataSource,
  apnsP8,
  pushNotification.token,
  apnsPayload,
  pushNotification,
  String((pushNotification as any).txid),
);

  }

  static async pushLightningInvoicePaid(
    dataSource: DataSource,
    serverKey: string,
    apnsP8: string,
    pushNotification: components["schemas"]["PushNotificationLightningInvoicePaid"]
  ): Promise<void> {
    const title = "+" + pushNotification.sat + " sats";
    const body = "Paid: " + (pushNotification.memo || "your invoice");

    const fcmPayload = {
      message: {
        token: "",
        data: {
          badge: String(pushNotification.badge),
          tag: pushNotification.hash,
        },
        notification: {
          title,
          body,
        },
        android: {
          notification: {
            tag: pushNotification.hash,
          },
        },
      },
    };

    const apnsPayload: any = {
      aps: {
        badge: pushNotification.badge,
        alert: { title, body },
        sound: "default",
      },
      data: {},
    };

    if (pushNotification.os === "android")
      return GroundControlToMajorTom._pushToFcm(dataSource, serverKey, pushNotification.token, fcmPayload, pushNotification);
    if (pushNotification.os === "ios")
      return GroundControlToMajorTom._pushToApns(dataSource, apnsP8, pushNotification.token, apnsPayload, pushNotification, String((pushNotification as any).hash));
  }

  protected static async _pushToApns(
    dataSource: DataSource,
    apnsP8: string,
    token: string,
    apnsPayload: any,
    pushNotification: components["schemas"]["PushNotificationBase"],
    collapseId: string
  ): Promise<void> {
    return new Promise(function (resolve) {
      for (let dataKey of Object.keys(pushNotification)) {
        if (["token", "os", "badge", "level"].includes(dataKey)) continue;
        apnsPayload["data"][dataKey] = (pushNotification as any)[dataKey];
      }

      const client = http2.connect("https://api.push.apple.com");
      client.on("error", (err) => console.error(err));

      const headers = {
        ":method": "POST",
        "apns-topic": process.env.APNS_TOPIC,
        "apns-collapse-id": collapseId,
        "apns-expiration": Math.floor(+new Date() / 1000 + 3600 * 24),
        ":scheme": "https",
        ":path": "/3/device/" + token,
        authorization: `bearer ${apnsP8}`,
      };

      const request = client.request(headers);

      let responseJson: any = {};
      request.on("response", (headers) => {
        for (const name in headers) {
          responseJson[name] = (headers as any)[name];
        }
      });

      request.on("error", (err) => {
        console.error("Apple push error:", err);

        responseJson["error"] = err;
        client.close();

        dataSource.getRepository(PushLog).save({
          token,
          os: "ios",
          payload: JSON.stringify(apnsPayload),
          response: JSON.stringify(responseJson),
          success: responseJson[":status"] === 200,
        });

        resolve();
      });

      request.setEncoding("utf8");

      let data = "";
      request.on("data", (chunk) => {
        data += chunk;
      });

      request.write(JSON.stringify(apnsPayload));

      request.on("end", () => {
        if (Object.keys(responseJson).length === 0) return;

        responseJson["data"] = data;
        client.close();

        GroundControlToMajorTom.processApnsResponse(dataSource, responseJson, token);

        dataSource.getRepository(PushLog).save({
          token,
          os: "ios",
          payload: JSON.stringify(apnsPayload),
          response: JSON.stringify(responseJson),
          success: responseJson[":status"] === 200,
        });

        resolve();
      });

      request.end();
    });
  }

  protected static async _pushToFcm(
    dataSource: DataSource,
    bearer: string,
    token: string,
    fcmPayload: any,
    pushNotification: components["schemas"]["PushNotificationBase"]
  ): Promise<void> {
    fcmPayload.message.token = token;

    for (let dataKey of Object.keys(pushNotification)) {
      if (["token", "os", "badge"].includes(dataKey)) continue;
      fcmPayload.message.data[dataKey] = String((pushNotification as any)[dataKey]);
    }

    const rawResponse = await fetch(
      `https://fcm.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(Object.assign({}, fcmPayload)),
      }
    );

    let responseText = "";
    try {
      responseText = await rawResponse.text();
    } catch (error) {
      console.error("error getting response from FCM", error);
    }

    delete fcmPayload.message.token;

    const success = GroundControlToMajorTom.processFcmResponse(dataSource, responseText, token);

    await dataSource.getRepository(PushLog).save({
      token,
      os: "android",
      payload: JSON.stringify(fcmPayload),
      response: responseText,
      success,
    });
  }

  static async killDeadToken(dataSource: DataSource, token: string) {
    console.log("deleting dead token", token);
    await dataSource.getRepository(TokenToAddress).createQueryBuilder().delete().where("token = :token", { token }).execute();
    await dataSource.getRepository(TokenToTxid).createQueryBuilder().delete().where("token = :token", { token }).execute();
    await dataSource.getRepository(TokenToHash).createQueryBuilder().delete().where("token = :token", { token }).execute();
  }

  static processFcmResponse(dataSource: DataSource, responseText: string, token: string): boolean {
    try {
      const response = JSON.parse(responseText);

      if (response?.error) {
        if (response.error.code === 404) {
          GroundControlToMajorTom.killDeadToken(dataSource, token);
          return false;
        }

        if (Array.isArray(response?.error?.details)) {
          for (const detail of response.error.details) {
            if (detail.errorCode === "UNREGISTERED") {
              GroundControlToMajorTom.killDeadToken(dataSource, token);
              return false;
            }
          }
        }
      }

      if (response?.name) return true;
    } catch (_) {
      console.error("error parsing FCM response", responseText);
      return false;
    }

    return false;
  }

  static processApnsResponse(dataSource: DataSource, response: any, token: string) {
    if (response && response.data) {
      try {
        const data = JSON.parse(response.data);
        if (data?.reason && ["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"].includes(data.reason)) {
          return GroundControlToMajorTom.killDeadToken(dataSource, token);
        }
      } catch (_) {}
    }
  }
}
