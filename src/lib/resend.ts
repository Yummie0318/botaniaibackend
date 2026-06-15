import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Email service is not configured.");
  }

  const { error } = await resend.emails.send({
    from: "Botaniai <no-reply@soulsyncai.site>",
    to: email,
    subject: "Your Botaniai verification code",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #f9fafb; border-radius: 12px;">
        <h2 style="color: #2e7d32; margin: 0 0 8px;">🌿 Botaniai</h2>
        <p style="color: #444; margin: 0 0 24px;">Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
        <div style="
          font-size: 40px;
          font-weight: bold;
          letter-spacing: 12px;
          color: #2e7d32;
          background: #fff;
          border: 2px solid #c8e6c9;
          border-radius: 8px;
          padding: 16px 24px;
          text-align: center;
          margin-bottom: 24px;
        ">
          ${code}
        </div>
        <p style="color: #888; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    console.error("[Resend] Failed to send OTP email:", error);
    throw new Error("Failed to send verification email. Please try again.");
  }
}