export type Platform = "twitch" | "youtube" | "kick";

export type ChatMessage = {
  platform: Platform;
  userId: string;
  user: string;
  text: string;
  ts: number;
};

export type ChatProvider = {
  platform: Platform;
  start(onMessage: (msg: ChatMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(text: string): Promise<void>;
};
