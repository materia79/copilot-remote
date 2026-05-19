import { joinSession } from "@github/copilot-sdk/extension";
import { spawn } from "node:child_process";

function buildMessageBoxScript(text, title, type) {
    return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeUser32 {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int MessageBoxW(IntPtr hWnd, string lpText, string lpCaption, uint uType);
}
"@
[NativeUser32]::MessageBoxW([IntPtr]::Zero, ${toPsString(text)}, ${toPsString(title)}, ${type}) | Out-Null
`;
}

function toPsString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowershell(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            await session.log("🪟 MessageBoxW tool loaded");
        },
    },
    tools: [
        {
            name: "open_message_box_w_bg",
            description: "Open a non-blocking native Windows MessageBoxW popup in a hidden background PowerShell process",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "Message text shown in the popup",
                    },
                    title: {
                        type: "string",
                        description: "Popup window title",
                    },
                    type: {
                        type: "number",
                        description: "Windows MessageBox type flags (default 0 = OK button)",
                    },
                },
                required: ["text", "title"],
            },
            handler: async (args) => {
                if (process.platform !== "win32") {
                    return "Error: open_message_box_w_bg is only supported on Windows.";
                }

                const type = Number.isFinite(Number(args?.type)) ? Number(args.type) : 0;
                const script = buildMessageBoxScript(args.text, args.title, type);
                const encoded = encodePowershell(script);
                const child = spawn(
                    "powershell",
                    ["-NoProfile", "-STA", "-EncodedCommand", encoded],
                    {
                        detached: true,
                        windowsHide: true,
                        stdio: "ignore",
                    },
                );
                child.unref();
                return `Launched MessageBoxW in background (PID ${child.pid}).`;
            },
        },
    ],
});
