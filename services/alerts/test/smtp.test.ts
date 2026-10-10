// SMTP client against an in-process fake server: STARTTLS upgrade + AUTH PLAIN + one message, AUTH LOGIN,
// refusal to send credentials without TLS, server errors.
import { afterEach, describe, expect, test } from "bun:test";
import { type Server, type Socket, createServer } from "node:net";
import { TLSSocket } from "node:tls";
import { buildMessage, encodeHeader, sendMail } from "../src/smtp";

// TEST-ONLY self-signed certificate for CN=localhost / 127.0.0.1 (no real system trusts it; used by the fake
// SMTP server below and passed to the client as its CA).
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3+fpwl0tuT6oQ034
NHtMRjK1UpoukcymrpXbCrDA1P+hRANCAASSKYHjahOWMS5d7wYNGu+fgG2uB2EN
lDo1GPsCu0mxcw5k91DUD8Qn1UeyKG3igffJDJbRuIqSG7pBnVG919kv
-----END PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUYTP84y01anXeZC9DkM83N+SL9l0wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxMDE5MTIxMFoYDzIxMjYwOTE2
MTkxMjEwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASSKYHjahOWMS5d7wYNGu+fgG2uB2ENlDo1GPsCu0mxcw5k91DUD8Qn
1UeyKG3igffJDJbRuIqSG7pBnVG919kvo28wbTAdBgNVHQ4EFgQUJk3ZUU4g/kQa
B5QVd+4jpsgh8JgwHwYDVR0jBBgwFoAUJk3ZUU4g/kQaB5QVd+4jpsgh8JgwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgXmUvj6r0XkW187K83gE7zaVTTd9hWJNe6sOBeFoY29UCIQDM
PsaeiPirBvOo9PEz734rjryslESZrZY0E/mn845BXg==
-----END CERTIFICATE-----
`;

interface Session {
  commands: string[];
  data: string;
  tlsUsed: boolean;
}

/** Minimal SMTP submission server. `auth`: advertised mechanisms; `starttls`: offer STARTTLS. */
function fakeSmtp(opts: { starttls: boolean; auth: string; rejectRcpt?: boolean }): Promise<{ server: Server; port: number; session: Session }> {
  const session: Session = { commands: [], data: "", tlsUsed: false };
  const server = createServer((raw: Socket) => {
    let sock: Socket = raw;
    let buf = "";
    let inData = false;
    let loginStep = 0;
    const send = (s: string) => sock.write(`${s}\r\n`);
    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          send("250 2.0.0 queued");
        } else session.data += `${line}\n`;
        return;
      }
      session.commands.push(line.startsWith("AUTH PLAIN") ? "AUTH PLAIN <b64>" : loginStep > 0 ? "<login>" : line);
      if (loginStep === 1) {
        loginStep = 2;
        return send("334 UGFzc3dvcmQ6");
      }
      if (loginStep === 2) {
        loginStep = 0;
        return send("235 2.7.0 ok");
      }
      const cmd = line.split(" ")[0]!.toUpperCase();
      if (cmd === "EHLO") {
        const caps = [...(opts.starttls && !session.tlsUsed ? ["STARTTLS"] : []), `AUTH ${opts.auth}`, "8BITMIME"];
        sock.write(`250-fake.local\r\n${caps.map((c, i) => `250${i === caps.length - 1 ? " " : "-"}${c}`).join("\r\n")}\r\n`);
      } else if (cmd === "STARTTLS") {
        send("220 2.0.0 go ahead");
        raw.removeAllListeners("data");
        const tls = new TLSSocket(raw, { isServer: true, key: KEY, cert: CERT });
        session.tlsUsed = true;
        sock = tls;
        buf = "";
        tls.setEncoding("utf8");
        tls.on("data", onData);
      } else if (cmd === "AUTH") {
        if (line.startsWith("AUTH PLAIN ")) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
          send(user === "alerts@bookrunner.tech" && pass === "s3cret" ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
        } else {
          loginStep = 1;
          send("334 VXNlcm5hbWU6");
        }
      } else if (cmd === "MAIL") send("250 ok");
      else if (cmd === "RCPT") send(opts.rejectRcpt ? "550 5.1.1 no such user" : "250 ok");
      else if (cmd === "DATA") {
        inData = true;
        send("354 go");
      } else if (cmd === "QUIT") {
        send("221 bye");
        sock.end();
      } else send("502 unknown");
    };
    const onData = (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    raw.setEncoding("utf8");
    raw.on("data", onData);
    raw.on("error", () => {});
    send("220 fake.local ESMTP");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, session })));
}

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

const base = { user: "alerts@bookrunner.tech", pass: "s3cret", from: "BookRunner alerts <alerts@bookrunner.tech>", to: ["ops@bookrunner.tech"], subject: "[BR] 1 firing", text: "line 1\n.leading dot\nline 3", timeoutMs: 5000 };

describe("sendMail", () => {
  test("STARTTLS (certificate verified), AUTH PLAIN, one message", async () => {
    const f = await fakeSmtp({ starttls: true, auth: "PLAIN LOGIN" });
    servers.push(f.server);
    await sendMail({ ...base, host: "localhost", port: f.port, tls: { ca: CERT } });
    expect(f.session.tlsUsed).toBe(true);
    expect(f.session.commands).toEqual(["EHLO localhost", "STARTTLS", "EHLO localhost", "AUTH PLAIN <b64>", "MAIL FROM:<alerts@bookrunner.tech>", "RCPT TO:<ops@bookrunner.tech>", "DATA", "QUIT"]);
    expect(f.session.data).toContain("Subject: [BR] 1 firing");
    expect(f.session.data).toContain("To: ops@bookrunner.tech");
    const body = f.session.data.split("\n\n")[1]!.replace(/\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("line 1\r\n.leading dot\r\nline 3");
  });

  test("an untrusted certificate is refused", async () => {
    const f = await fakeSmtp({ starttls: true, auth: "PLAIN" });
    servers.push(f.server);
    await expect(sendMail({ ...base, host: "localhost", port: f.port })).rejects.toThrow();
  });

  test("no STARTTLS offered: credentials are never sent in clear", async () => {
    const f = await fakeSmtp({ starttls: false, auth: "PLAIN" });
    servers.push(f.server);
    await expect(sendMail({ ...base, host: "127.0.0.1", port: f.port })).rejects.toThrow(/no STARTTLS/);
    expect(f.session.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
  });

  test("AUTH LOGIN when PLAIN is not offered (loopback test server, insecure allowed)", async () => {
    const f = await fakeSmtp({ starttls: false, auth: "LOGIN" });
    servers.push(f.server);
    await sendMail({ ...base, host: "127.0.0.1", port: f.port, insecure: true });
    expect(f.session.commands.slice(0, 4)).toEqual(["EHLO localhost", "AUTH LOGIN", "<login>", "<login>"]);
  });

  test("server errors surface with their code", async () => {
    const f = await fakeSmtp({ starttls: false, auth: "PLAIN", rejectRcpt: true });
    servers.push(f.server);
    await expect(sendMail({ ...base, host: "127.0.0.1", port: f.port, insecure: true })).rejects.toThrow(/RCPT: 550/);
    const g = await fakeSmtp({ starttls: false, auth: "PLAIN" });
    servers.push(g.server);
    await expect(sendMail({ ...base, pass: "wrong", host: "127.0.0.1", port: g.port, insecure: true })).rejects.toThrow(/AUTH: 535/);
  });
});

describe("message", () => {
  test("headers: RFC 2047 for non-ASCII subjects, no header injection", () => {
    expect(encodeHeader("plain")).toBe("plain");
    expect(encodeHeader("über")).toBe(`=?UTF-8?B?${Buffer.from("über").toString("base64")}?=`);
    expect(encodeHeader("a\r\nBcc: x@y")).toBe("a Bcc: x@y");
    const m = buildMessage({ from: "a@b.c", to: ["d@e.f"], subject: "s", text: "hi" }, new Date(Date.UTC(2026, 9, 10)), "<id@b.c>");
    expect(m).toContain("Date: Sat, 10 Oct 2026 00:00:00 +0000");
    expect(m).toContain("Content-Transfer-Encoding: base64");
    expect(m.split("\r\n\r\n")[1]).toBe(`${Buffer.from("hi").toString("base64")}\r\n`);
  });
});
