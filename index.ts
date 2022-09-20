import {
  Client,
  ClientConfig,
  MessageAPIResponseBase,
  middleware,
  MiddlewareConfig,
  TextMessage,
  WebhookEvent,
} from "@line/bot-sdk";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import bbt from "beebotte";
import express, { Application, Request, Response } from "express";
import { createClient as createRedisClient } from "redis";

var bbtClient = new bbt.Connector({
  apiKey: process.env.BBT_API_KEY,
  secretKey: process.env.BBT_ACCESS_KEY,
});

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

const clientConfig: ClientConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.CHANNEL_SECRET,
};

const middlewareConfig: MiddlewareConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET || "",
};

const PORT = process.env.PORT || 3000;

const lineBotClient = new Client(clientConfig);

const app: Application = express();

const redisClient = createRedisClient({
  url: process.env.REDIS_URL,
});

const handleOK = (replyToken: string) =>
  lineBotClient.replyMessage(replyToken, {
    type: "text",
    text: "OK",
  });

const handleInternalError = (replyToken: string, reason?: string) =>
  lineBotClient.replyMessage(replyToken, {
    type: "text",
    text: reason ? `内部エラー: ${reason}` : "内部エラーが発生しました",
  });

const handleUnknown = (replyToken: string) =>
  lineBotClient.replyMessage(replyToken, {
    type: "text",
    text: "ちょっと何言ってるか分からない",
  });

const textEventHandler = async (
  event: WebhookEvent
): Promise<MessageAPIResponseBase | undefined> => {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const {
    replyToken,
    source: { userId },
  } = event;
  const { text: rawText } = event.message;

  const [cmd, heading] = rawText.split(/\s|\n/);
  const text = rawText.replace(cmd, "").replace(heading, "").trim();

  try {
    if (!userId) {
      await handleInternalError(replyToken, "利用者IDを取得できませんでした");
      return;
    }

    await redisClient.connect();
    const kvsState = await redisClient.hGetAll(userId);
    switch (cmd) {
      case "sp":
      case "speech": {
        const [_, ...ttsText] = rawText.split(/\s|\n/);

        const { error } = await supabase
          .from("speechRequest")
          .insert([{ text: ttsText.join("") }]);
        if (!error) {
          await handleOK(replyToken);
        }
        await handleInternalError(replyToken);
      }
      case "un":
      case "update_note": {
        const { error } = await supabase
          .from("bulletinboard")
          .insert([{ heading, text }]);
        if (!error) {
          await handleOK(replyToken);
          break;
        }
        handleInternalError(replyToken);
        break;
      }
      case "pt":
      case "party": {
        const channel = "praise";
        const resource = "count";
        bbtClient.read(
          {
            channel,
            resource,
            limit: 1,
          },
          async (readErr: Error, res: { data: number }[]) => {
            if (readErr) {
              console.error(readErr);
              await handleInternalError(replyToken);
              return;
            }

            bbtClient.write(
              { channel, resource, data: res[0].data + 1 },
              async (writeErr: Error) => {
                if (writeErr) {
                  console.error(writeErr);
                  await handleInternalError(replyToken);
                  return;
                }
                await handleOK(replyToken);
              }
            );
          }
        );
        break;
      }
      case "guided_update_note":
        const alreadyStarted = await redisClient.exists(userId);
        if (alreadyStarted) {
          break;
        }

        await redisClient.hSet(userId, "conversationState", "initial");
        await redisClient.hSet(userId, "heading", "");
        await redisClient.hSet(userId, "body", "");
        const response: TextMessage = {
          type: "text",
          text: "タイトルを入力してください:",
        };
        await lineBotClient.replyMessage(replyToken, response);
        break;
      case "exit_guided":
        await redisClient.hDel(userId, ["conversationState", "title", "body"]);
        await handleOK(replyToken);
        break;
      default: {
        if (!kvsState.conversationState) {
          handleUnknown(replyToken);
        }
        break;
      }
    }
    switch (kvsState.conversationState) {
      case "initial": {
        await redisClient.hSet(userId, "heading", rawText.trim());
        await redisClient.hSet(userId, "conversationState", "heading_passed");

        await lineBotClient.replyMessage(replyToken, {
          type: "text",
          text: "本文を入力してください:",
        });
        break;
      }
      case "heading_passed": {
        await redisClient.hSet(userId, "body", rawText.trim());
        await lineBotClient.replyMessage(replyToken, {
          type: "text",
          text: "KDSタブレットに反映しました。ご利用ありがとうございました！",
        });

        const newKvsState = await redisClient.hGetAll(userId);
        await supabase
          .from("bulletinboard")
          .insert([{ heading: newKvsState.heading, text: newKvsState.body }]);
        await redisClient.del(userId);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    handleInternalError(replyToken);
  }

  await redisClient.disconnect();
};

app.get("/", async (_: Request, res: Response): Promise<Response> => {
  return res.status(200).json({
    status: "success",
    message: "Connected successfully!",
  });
});

app.post(
  "/webhook",
  middleware(middlewareConfig),
  async (req: Request, res: Response): Promise<Response> => {
    const events: WebhookEvent[] = req.body.events;

    const results = await Promise.all(
      events.map(async (event: WebhookEvent) => {
        try {
          await textEventHandler(event);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.error(err);
          }

          return res.status(500).json({
            status: "error",
          });
        }
      })
    );

    return res.status(200).json({
      status: "success",
      results,
    });
  }
);

app.listen(PORT, () => {
  console.log(`Application is live and listening on port ${PORT}`);
});
