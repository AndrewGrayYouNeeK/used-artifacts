import { serverEnv } from "@/config/env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

class PostmarkMailer implements Mailer {
  constructor(
    private readonly token: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.token,
      },
      body: JSON.stringify({
        From: this.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        MessageStream: "outbound",
      }),
    });
    if (!res.ok) {
      throw new Error(`Postmark send failed: ${res.status} ${await res.text()}`);
    }
  }
}

/** Development only: prints emails (including links) to the server log. */
class ConsoleMailer implements Mailer {
  async send(message: EmailMessage): Promise<void> {
    console.info(
      `\n[email] to=${message.to}\n[email] subject=${message.subject}\n${message.text}\n`,
    );
  }
}

/** Test helper: keeps sent messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

let mailer: Mailer | undefined;

export function getMailer(): Mailer {
  if (mailer) return mailer;
  const env = serverEnv();
  if (env.POSTMARK_SERVER_TOKEN) {
    mailer = new PostmarkMailer(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM);
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("POSTMARK_SERVER_TOKEN must be set in production");
  } else {
    mailer = new ConsoleMailer();
  }
  return mailer;
}
