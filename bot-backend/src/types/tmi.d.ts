declare module "tmi.js" {
  export type ChatUserstate = Record<string, unknown> & {
    username?: string;
    "display-name"?: string;
    "user-id"?: string;
  };

  export class Client {
    constructor(opts: Record<string, unknown>);
    on(
      event: "message",
      cb: (channel: string, tags: ChatUserstate, message: string, self: boolean) => void
    ): void;
    connect(): Promise<[string, number]>;
    disconnect(): Promise<[string, number]>;
    say(channel: string, message: string): Promise<[string]>;
  }

  const tmi: { Client: typeof Client };
  export default tmi;
}
