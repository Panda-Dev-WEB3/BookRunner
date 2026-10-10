// Minimal SMTP submission client (no dependency): EHLO, STARTTLS (port 587) or implicit TLS (465),
// AUTH PLAIN / LOGIN, one plain-text UTF-8 message. Credentials are never sent before TLS is up, except
// to a loopback test server with `insecure: true`. The certificate is verified against `host`.
import { randomBytes } from "node:crypto";
import { type Socket, connect as netConnect } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** EHLO name (default: localhost) */
  name?: string;
  timeoutMs?: number;
  /** tests only: allow AUTH without TLS (loopback hosts only) */
  insecure?: boolean;
  /** tests only: extra TLS options (e.g. a self-signed CA) */
  tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean };
  now?: () => Date;
}

interface Reply {
  code: number;
  lines: string[];
}

class Conn {
  private buf = "";
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private pending: Reply[] = [];
  private failed: Error | null = null;
  private current: string[] = [];

  constructor(public sock: Socket | TLSSocket) {
    this.attach(sock);
  }

  attach(sock: Socket | TLSSocket) {
    this.sock = sock;
    this.buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.onData(d));
    sock.on("error", (e: Error) => this.fail(e));
    sock.on("close", () => this.fail(new Error("connection closed")));
  }

  /** Stops listening on the current socket (before a STARTTLS upgrade). */
  detach() {
    this.sock.removeAllListeners("data");
    this.sock.removeAllListeners("error");
    this.sock.removeAllListeners("close");
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.current.push(line);
      // "250-..." continues, "250 ..." (or a bare "250") ends the reply
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.current.map((l) => l.slice(4)) };
        this.current = [];
        const w = this.waiters.shift();
        if (w) w.resolve(reply);
        else this.pending.push(reply);
      }
    }
  }

  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  read(): Promise<Reply> {
    const p = this.pending.shift();
    if (p) return Promise.resolve(p);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  write(line: string) {
    this.sock.write(`${line}\r\n`);
  }

  async cmd(line: string, expect: number[], what = line.split(" ")[0]!): Promise<Reply> {
    this.write(line);
    const r = await this.read();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${what}: ${r.code} ${r.lines.join(" ").slice(0, 200)}`);
    return r;
  }
}

const isLoopback = (h: string) => h === "localhost" || h === "::1" || /^127\./.test(h);

/** RFC 2047 encoded-word when the header has non-ASCII characters. */
export function encodeHeader(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** The full message (headers + base64 body), CRLF line endings. */
export function buildMessage(o: Pick<SmtpOptions, "from" | "to" | "subject" | "text">, date: Date, messageId: string): string {
  const body = Buffer.from(o.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${o.from}`,
    `To: ${o.to.join(", ")}`,
    `Subject: ${encodeHeader(o.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}

const addr = (s: string) => {
  const m = /<([^>]+)>/.exec(s);
  const a = (m ? m[1]! : s).trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(a)) throw new Error(`invalid email address: ${a}`);
  return a;
};

export async function sendMail(o: SmtpOptions): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const implicitTls = o.port === 465;
  const tlsOpts = { servername: o.host, ...(o.tls ?? {}) };
  const raw: Socket | TLSSocket = implicitTls ? tlsConnect({ host: o.host, port: o.port, ...tlsOpts }) : netConnect({ host: o.host, port: o.port });
  const conn = new Conn(raw);
  const timer = setTimeout(() => conn.sock.destroy(new Error(`SMTP timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    const hello = await conn.read();
    if (hello.code !== 220) throw new Error(`SMTP greeting: ${hello.code} ${hello.lines.join(" ")}`);
    const name = o.name ?? "localhost";
    let caps = (await conn.cmd(`EHLO ${name}`, [250])).lines;
    let secure = implicitTls;
    if (!secure && caps.some((l) => /^STARTTLS\b/i.test(l))) {
      await conn.cmd("STARTTLS", [220]);
      conn.detach();
      const plain = conn.sock as Socket;
      const upgraded = tlsConnect({ socket: plain, ...tlsOpts });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      conn.attach(upgraded);
      secure = true;
      caps = (await conn.cmd(`EHLO ${name}`, [250])).lines;
    }
    if (!secure && !(o.insecure && isLoopback(o.host))) throw new Error(`SMTP server ${o.host}:${o.port} offers no STARTTLS: refusing to send credentials in clear`);
    const auth = caps.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? "";
    if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
      await conn.cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`, "utf8").toString("base64")}`, [235], "AUTH");
    } else {
      await conn.cmd("AUTH LOGIN", [334], "AUTH");
      await conn.cmd(Buffer.from(o.user, "utf8").toString("base64"), [334], "AUTH user");
      await conn.cmd(Buffer.from(o.pass, "utf8").toString("base64"), [235], "AUTH pass");
    }
    await conn.cmd(`MAIL FROM:<${addr(o.from)}>`, [250], "MAIL");
    for (const to of o.to) await conn.cmd(`RCPT TO:<${addr(to)}>`, [250, 251], "RCPT");
    await conn.cmd("DATA", [354]);
    const domain = addr(o.from).split("@")[1];
    const msg = buildMessage(o, (o.now ?? (() => new Date()))(), `<${randomBytes(12).toString("hex")}@${domain}>`);
    // dot-stuffing (a line starting with "." gets one more); base64 bodies never start with ".", headers might
    conn.sock.write(`${msg.replace(/\r\n\./g, "\r\n..")}\r\n.\r\n`);
    const done = await conn.read();
    if (done.code !== 250) throw new Error(`SMTP DATA: ${done.code} ${done.lines.join(" ").slice(0, 200)}`);
    conn.write("QUIT");
    await conn.read().catch(() => undefined);
  } finally {
    clearTimeout(timer);
    conn.sock.destroy();
  }
}
