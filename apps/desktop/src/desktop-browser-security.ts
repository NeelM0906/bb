import type { BbDesktopBrowserImportCookiesRequest } from "@bb/desktop-contract";
import type {
  BrowserImportService,
  CookieWriteSession,
} from "./browser-import/browser-import.js";

export function isTrustedDesktopBrowserOrigin(
  url: string,
  builtinRuntimeUrl: string | null,
): boolean {
  if (builtinRuntimeUrl === null) return false;
  try {
    const trusted = new URL(builtinRuntimeUrl);
    const actual = new URL(url);
    return (
      (trusted.protocol === "http:" || trusted.protocol === "https:") &&
      actual.origin === trusted.origin
    );
  } catch {
    return false;
  }
}

export function isTrustedDesktopBrowserFrame(args: {
  senderFrame: { url: string } | null;
  mainFrame: { url: string };
  builtinRuntimeUrl: string | null;
}): boolean {
  return (
    args.senderFrame === args.mainFrame &&
    isTrustedDesktopBrowserOrigin(args.mainFrame.url, args.builtinRuntimeUrl)
  );
}

export async function importDesktopBrowserCookiesWithConsent(args: {
  request: BbDesktopBrowserImportCookiesRequest;
  service: BrowserImportService;
  authorization: () => string | null;
  confirm: (detail: string) => Promise<boolean>;
  session: () => CookieWriteSession;
}) {
  const authorization = args.authorization();
  const deadline = Date.now() + 10_000;
  const requireAuthorization = () => {
    if (
      authorization === null ||
      args.authorization() !== authorization ||
      Date.now() >= deadline
    )
      throw new Error(
        "Browser cookie import is not authorized for this window",
      );
  };
  requireAuthorization();
  const request = { ...args.request, profile: { ...args.request.profile } };
  const sources = await args.service.listSources();
  requireAuthorization();
  const source = sources.find((source) => source.id === request.sourceId);
  const profile = source?.profiles.find(
    (profile) => profile.directory === request.sourceProfileDirectory,
  );
  if (!source || !profile)
    throw new Error("Browser import source profile is unavailable");
  const destination =
    request.profile.kind === "personal"
      ? "BB personal browser profile"
      : `BB automation profile ${request.profile.id}`;
  const approved = await args.confirm(
    `Import signed-in browser sessions from ${source.name}, profile ${profile.name} (${profile.directory}), into ${destination}?\n\nBB and agents using this destination profile will be able to access the imported accounts.`,
  );
  requireAuthorization();
  if (!approved) throw new Error("Browser cookie import was declined");
  const session = args.session();
  const result = await args.service.importCookies(
    {
      sourceId: request.sourceId,
      sourceProfileDirectory: request.sourceProfileDirectory,
    },
    {
      cookies: {
        set: (details) => {
          requireAuthorization();
          return session.cookies.set(details);
        },
        flushStore: () => {
          requireAuthorization();
          return session.cookies.flushStore();
        },
      },
    },
  );
  requireAuthorization();
  return result;
}
