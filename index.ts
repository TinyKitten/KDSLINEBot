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
import express, { Application, Request, Response } from "express";
import { createClient as createRedisClient } from "redis";

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

const textEventHandler = async (
  event: WebhookEvent
): Promise<MessageAPIResponseBase | undefined> => {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  await redisClient.connect();

  const {
    replyToken,
    source: { userId },
  } = event;
  const { text: rawText } = event.message;

  const [cmd, heading] = rawText.split(/\s|\n/);
  const text = rawText.replace(cmd, "").replace(heading, "").trim();

  if (!userId) {
    const response: TextMessage = {
      type: "text",
      text: "Could not get userId",
    };
    await lineBotClient.replyMessage(replyToken, response);
    await redisClient.disconnect();
    return;
  }

  try {
    switch (cmd) {
      case "un":
      case "update_note":
        const { error } = await supabase
          .from("bulletinboard")
          .insert([{ heading, text }]);
        if (!error) {
          const response: TextMessage = {
            type: "text",
            text: "OK",
          };
          await lineBotClient.replyMessage(replyToken, response);
        } else {
          const response: TextMessage = {
            type: "text",
            text: "ERROR",
          };
          await lineBotClient.replyMessage(replyToken, response);
        }
        break;
      case "guided_update_note":
        await redisClient.hSet(userId, "conversationState", "initial");
        await redisClient.hSet(userId, "heading", "");
        await redisClient.hSet(userId, "body", "");
        const response: TextMessage = {
          type: "text",
          text: "Okay! Please enter a title:",
        };
        await lineBotClient.replyMessage(replyToken, response);
        break;
      case "exit_guided":
        await redisClient.hDel(userId, ["conversationState", "title", "body"]);
        await lineBotClient.replyMessage(replyToken, {
          type: "text",
          text: "OK",
        });

      default: {
        const kvsState = await redisClient.hGetAll(userId);
        console.log(kvsState);
        switch (kvsState.conversationState) {
          case "initial": {
            if (rawText.trim().length === 0) {
              await lineBotClient.replyMessage(replyToken, {
                type: "text",
                text: `Oops! Can't leave the title empty!`,
              });
              break;
            }
            await redisClient.hSet(userId, "heading", rawText.trim());
            await lineBotClient.replyMessage(replyToken, {
              type: "text",
              text: `Okay! Continue with the following title: ${rawText.trim()}\nThen enter the body of the message:`,
            });

            await redisClient.hSet(
              userId,
              "conversationState",
              "heading_passed"
            );
            break;
          }
          case "heading_passed": {
            if (rawText.trim().length === 0) {
              await lineBotClient.replyMessage(replyToken, {
                type: "text",
                text: `Oops! Can't empty the text!`,
              });
              break;
            }
            await redisClient.hSet(userId, "body", rawText.trim());
            await lineBotClient.replyMessage(replyToken, {
              type: "text",
              text: `Okay! Continue with the following text:\n${rawText.trim()}\nThank you for using the KDS BOT!`,
            });

            const newKvsState = await redisClient.hGetAll(userId);
            await supabase
              .from("bulletinboard")
              .insert([
                { heading: newKvsState.heading, text: newKvsState.body },
              ]);
            await redisClient.hDel(userId, [
              "conversationState",
              "title",
              "body",
            ]);
            break;
          }
        }

        const unkResponse: TextMessage = {
          type: "text",
          text: "???",
        };
        await lineBotClient.replyMessage(replyToken, unkResponse);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    const response: TextMessage = {
      type: "text",
      text: `ERROR`,
    };
    await lineBotClient.replyMessage(replyToken, response);
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
