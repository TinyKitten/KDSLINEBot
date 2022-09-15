import {
  Client,
  ClientConfig,
  MessageAPIResponseBase,
  middleware,
  MiddlewareConfig,
  TextMessage,
  WebhookEvent,
} from "@line/bot-sdk";
import { createClient } from "@supabase/supabase-js";
import express, { Application, Request, Response } from "express";

const supabase = createClient(
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

const client = new Client(clientConfig);

const app: Application = express();

const textEventHandler = async (
  event: WebhookEvent
): Promise<MessageAPIResponseBase | undefined> => {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const { replyToken } = event;
  const { text } = event.message;

  const [cmd, ...args] = text.split(/\n|\s/).map((t) => t.trim());

  try {
    switch (cmd) {
      case "un":
      case "update_note":
        const [heading, ...body] = args;
        const { error } = await supabase
          .from("bulletinboard")
          .insert([{ heading, text: body.join("\n") }]);
        if (!error) {
          const response: TextMessage = {
            type: "text",
            text: "OK",
          };
          await client.replyMessage(replyToken, response);
        } else {
          const response: TextMessage = {
            type: "text",
            text: `ERROR\n${JSON.stringify(error)}`,
          };
          await client.replyMessage(replyToken, response);
        }
        break;
      default:
        const response: TextMessage = {
          type: "text",
          text: "???",
        };
        await client.replyMessage(replyToken, response);
    }
  } catch (err) {
    const response: TextMessage = {
      type: "text",
      text: `ERROR\n${JSON.stringify(err)}`,
    };
    await client.replyMessage(replyToken, response);
  }
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
