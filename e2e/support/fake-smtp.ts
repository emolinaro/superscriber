import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";

/**
 * Canonical fake SMTP server for E2E: a tolerant minimal submission server
 * (EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA) plus an HTTP control channel
 * exposing captured messages. Mirrors the fake-oidc sidecar pattern so the
 * same code runs in-process or inside the container netns sidecar.
 */

export type CapturedMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
};

export const E2E_SMTP_PORT = Number(process.env.SUPERSCRIBER_E2E_SMTP_PORT || 4205);
export const E2E_SMTP_CONTROL_PORT = Number(
  process.env.SUPERSCRIBER_E2E_SMTP_CONTROL_PORT || 4206,
);

function parseMessage(raw: string, envelope: { from: string; to: string[] }): CapturedMessage {
  const [head = "", ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const subject =
    head
      .split(/\r?\n/)
      .find((line) => /^subject:/i.test(line))
      ?.replace(/^subject:\s*/i, "") ?? "";
  return {
    from: envelope.from,
    to: envelope.to,
    subject,
    text: bodyParts.join("\n\n"),
  };
}

function handleSmtpConnection(socket: Socket, captured: CapturedMessage[]) {
  const envelope = { from: "", to: [] as string[] };
  let buffer = "";
  let inData = false;
  let dataBuffer = "";

  function send(line: string) {
    socket.write(`${line}\r\n`);
  }

  socket.setEncoding("utf8");
  send("220 fake-smtp ready");

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    // Deliberately simple line processing; tests own determinism.
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (inData) {
        if (line === ".") {
          inData = false;
          captured.push(parseMessage(dataBuffer, envelope));
          dataBuffer = "";
          send("250 message accepted");
        } else {
          dataBuffer += `${line.replace(/^\.\./, ".")}\r\n`;
        }
      } else if (/^(EHLO|HELO)/i.test(line)) {
        send("250-fake-smtp greets you");
        send("250 AUTH PLAIN");
      } else if (/^AUTH PLAIN/i.test(line)) {
        send("235 authenticated");
      } else if (/^MAIL FROM:/i.test(line)) {
        envelope.from = line.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, "");
        send("250 sender ok");
      } else if (/^RCPT TO:/i.test(line)) {
        envelope.to.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, ""));
        send("250 recipient ok");
      } else if (/^DATA/i.test(line)) {
        inData = true;
        send("354 end with <CR><LF>.<CR><LF>");
      } else if (/^RSET/i.test(line)) {
        envelope.from = "";
        envelope.to = [];
        send("250 cleared");
      } else if (/^NOOP/i.test(line)) {
        send("250 ok");
      } else if (/^QUIT/i.test(line)) {
        send("221 bye");
        socket.end();
        return;
      } else {
        send("250 ok");
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

export function startFakeSmtpServers(smtpPort: number, controlPort: number) {
  const captured: CapturedMessage[] = [];

  const smtp = createNetServer((socket) => handleSmtpConnection(socket, captured));
  smtp.listen(smtpPort, "0.0.0.0");

  const control = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(captured));
      return;
    }
    if (req.method === "POST" && req.url === "/reset") {
      captured.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  control.listen(controlPort, "0.0.0.0");

  return { smtpPort, controlPort };
}

export type SmtpControl = {
  messages(): Promise<CapturedMessage[]>;
  reset(): Promise<void>;
};

export function smtpControl(baseUrl: string): SmtpControl {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async messages() {
      const response = await fetch(`${base}/messages`);
      if (!response.ok) {
        throw new Error(`fake smtp control /messages failed: ${response.status}`);
      }
      return (await response.json()) as CapturedMessage[];
    },
    async reset() {
      const response = await fetch(`${base}/reset`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`fake smtp control /reset failed: ${response.status}`);
      }
    },
  };
}

export function e2eSmtpControl() {
  return smtpControl(`http://127.0.0.1:${E2E_SMTP_CONTROL_PORT}`);
}
