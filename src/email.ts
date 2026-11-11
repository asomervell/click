import { ClickError } from "./types";

/** One verification message. The code is only ever held in memory and in the mail itself. */
export type VerificationMail = {
  to: string;
  code: string;
  expiresAt: number;
  clickName: string | null;
};

export interface EmailSender {
  readonly kind: "cloudflare" | "test";
  sendVerification(mail: VerificationMail): Promise<void>;
}

export type SignupMode =
  | { verify: true; sender: EmailSender }
  | { verify: false; reason: "unverified_flag" };

const DEFAULT_FROM = "verify@clickmcp.com";

/** Test-only outbox. Used only when the TEST_EMAIL_OUTBOX binding is "1", which wrangler.jsonc never sets. */
export const testOutbox: VerificationMail[] = [];
/** Test-only: the next N test sends throw, to exercise the failed-send path. */
export const testSendFailures = { remaining: 0 };

function setting(env: Env, name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name];
}

function cloudflareSender(binding: SendEmail, from: string): EmailSender {
  return {
    kind: "cloudflare",
    async sendVerification(mail) {
      const { subject, text, html } = verificationEmail(mail);
      await binding.send({
        from: { email: from, name: "Click" },
        to: mail.to,
        subject,
        text,
        html,
      });
    },
  };
}

/** Subject and bodies of the verification email. */
export function verificationEmail(mail: Pick<VerificationMail, "code" | "clickName">): { subject: string; text: string; html: string } {
  const name = mail.clickName?.trim() || "your click";
  const outro = "If this was not you, ignore this email. No click is created without the code.";
  return {
    subject: `Click code ${mail.code}`,
    text: [`The verification code for ${name} is`, "", mail.code, "", outro].join("\n"),
    html: `<p>The verification code for ${escape(name)} is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${escape(mail.code)}</p><p>${outro}</p>`,
  };
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The sender that is live for this deployment, or null when none is configured. */
export function emailSender(env: Env): EmailSender | null {
  if (setting(env, "TEST_EMAIL_OUTBOX") === "1") {
    return {
      kind: "test",
      async sendVerification(mail) {
        if (testSendFailures.remaining > 0) {
          testSendFailures.remaining -= 1;
          throw new Error("test send failure");
        }
        testOutbox.push(mail);
      },
    };
  }
  const binding = setting(env, "EMAIL") as SendEmail | undefined;
  if (binding && typeof binding.send === "function") {
    const from = String(setting(env, "EMAIL_FROM") ?? "").trim() || DEFAULT_FROM;
    return cloudflareSender(binding, from);
  }
  return null;
}

/**
 * Verification is required whenever a sender is live. Without one, only the
 * ALLOW_UNVERIFIED_SIGNUP="true" flag keeps the old immediate-key behavior.
 */
export function signupMode(env: Env): SignupMode {
  const sender = emailSender(env);
  if (sender) return { verify: true, sender };
  if (setting(env, "ALLOW_UNVERIFIED_SIGNUP") === "true") return { verify: false, reason: "unverified_flag" };
  throw new ClickError("Creating clicks is paused: email verification is not configured on this server.");
}
