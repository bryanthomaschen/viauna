// Development SMTP server for Viauna. Accepts any login, and delivers every message to
// each recipient's mailbox on the dev Dovecot over LMTP — so sending from
// alice@example.test to bob@example.test lands in Bob's inbox, live, exactly as it
// would on a real server. Nothing ever leaves the machine.
//
// Listens on 127.0.0.1:1587 (plaintext, no TLS). Never bind this anywhere else.
import { SMTPServer } from "smtp-server";
import SMTPConnection from "nodemailer/lib/smtp-connection";

const PORT = Number(process.env.SINK_PORT || 1587);
const LMTP_PORT = Number(process.env.LMTP_PORT || 1024);

function deliver(envelope, raw) {
  return new Promise((resolve, reject) => {
    const conn = new SMTPConnection({ host: "127.0.0.1", port: LMTP_PORT, lmtp: true, ignoreTLS: true });
    conn.on("error", reject);
    conn.connect(() => {
      conn.send(envelope, raw, (err, info) => {
        conn.quit();
        if (err) reject(err);
        else resolve(info);
      });
    });
  });
}

const server = new SMTPServer({
  authOptional: false,
  allowInsecureAuth: true,
  disabledCommands: ["STARTTLS"],
  logger: false,
  onAuth(auth, _session, cb) {
    cb(null, { user: auth.username });
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const envelope = {
        from: session.envelope.mailFrom?.address || "",
        to: session.envelope.rcptTo.map((r) => r.address),
      };
      try {
        await deliver(envelope, raw);
        console.log(`delivered ${raw.length} bytes from ${envelope.from} to ${envelope.to.join(", ")}`);
        cb();
      } catch (err) {
        console.error("LMTP delivery failed:", err.message);
        cb(err);
      }
    });
  },
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dev SMTP sink on 127.0.0.1:${PORT} → LMTP 127.0.0.1:${LMTP_PORT}`);
});
