import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Credential } from "./credentials";
import { at, record } from "./model";
import { ProviderError } from "./providers";

type RunCommand = (file: string, args: string[], timeout: number) => Promise<string>;
const runCommand: RunCommand = async (file, args, timeout) => {
  const { stdout } = await promisify(execFile)(file, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout;
};
const windowsKeyringScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class AiQuotaAntigravityCredential {
  [StructLayout(LayoutKind.Sequential)]
  private struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr pointer);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr pointer);
  public static string Read() {
    IntPtr pointer;
    if (!CredRead("gemini:antigravity", 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return "";
      throw new Win32Exception(error);
    }
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.BlobSize == 0 || credential.BlobSize > 1048576)
        throw new InvalidOperationException("Invalid Antigravity credential size.");
      byte[] bytes = new byte[credential.BlobSize];
      Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(pointer); }
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Write([AiQuotaAntigravityCredential]::Read())
`;

export function parseAntigravityCredential(secret: string): Credential {
  let data: unknown;
  try {
    const raw = secret.trim();
    data = JSON.parse(raw.startsWith("go-keyring-base64:")
      ? Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8") : raw) as unknown;
  } catch { throw new ProviderError("Cannot parse Antigravity CLI credentials. Run agy to sign in again.", "auth"); }
  const method = at(data, "auth_method");
  if (method !== undefined && method !== "consumer") {
    throw new ProviderError("Antigravity CLI enterprise authentication is not supported by this quota reader.");
  }
  const tokenData = at(data, "token") ?? data;
  const token = at(tokenData, "access_token");
  const expiry = at(tokenData, "expiry");
  if (typeof token !== "string" || !/^[A-Za-z0-9_.~+/=:-]+$/.test(token)) {
    throw new ProviderError("Antigravity CLI has no valid saved access token. Run agy to sign in again.", "auth");
  }
  const expiresAt = expiry === undefined ? undefined : typeof expiry === "string" ? Date.parse(expiry) : NaN;
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
    throw new ProviderError("Antigravity CLI saved an invalid token expiry. Run agy and /usage, then refresh.", "auth");
  }
  return { token, expiresAt };
}
export async function readAntigravityKeyring(
  timeout: number, run: RunCommand = runCommand, platform = process.platform
): Promise<string | undefined> {
  try {
    let raw: string;
    if (platform === "win32") {
      const shell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      raw = await run(shell, [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsKeyringScript, "utf16le").toString("base64")
      ], timeout);
    } else if (platform === "darwin") {
      raw = await run("/usr/bin/security", ["find-generic-password", "-a", "antigravity", "-s", "gemini", "-w"], timeout);
    } else {
      raw = await run("/usr/bin/secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], timeout);
    }
    return raw.trim() ? raw : undefined;
  } catch (error) {
    const code = record(error).code;
    const emptyError = typeof record(error).stderr !== "string" || !String(record(error).stderr).trim();
    if (platform === "darwin" && code === 44 ||
        platform !== "win32" && platform !== "darwin" && (code === "ENOENT" || code === 1 && emptyError)) {
      return undefined;
    }
    throw new ProviderError("Cannot read Antigravity CLI's OS keyring. Check keyring permissions or set aiquota.credentialPaths.antigravity to its token file.");
  }
}
export function antigravityTokenFile(env = process.env, home = homedir()): string {
  return join(env.AGY_DIR || join(home, ".gemini", "antigravity-cli"), "antigravity-oauth-token");
}
export async function loadAntigravityCredential(
  timeout: number, customPath?: string,
  keyring: (timeout: number) => Promise<string | undefined> = readAntigravityKeyring
): Promise<Credential | undefined> {
  if (customPath && !isAbsolute(customPath)) { throw new ProviderError("Antigravity CLI credential paths must be absolute."); }
  if (!customPath) {
    const secret = await keyring(timeout);
    if (secret !== undefined) { return parseAntigravityCredential(secret); }
  }
  let raw: string;
  try { raw = await readFile(customPath || antigravityTokenFile(), "utf8"); }
  catch (error) {
    if (record(error).code === "ENOENT") { return undefined; }
    throw new ProviderError("Cannot read Antigravity CLI's token file. Check file permissions.");
  }
  return parseAntigravityCredential(raw);
}
