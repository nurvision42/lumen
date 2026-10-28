export type FeishuBrand = "feishu" | "lark";

export interface FeishuHosts {
  brand: FeishuBrand;
  accounts: string;
  open: string;
  /** Host used in fallback document links. */
  docs: string;
}

export function parseBrand(value: string | undefined): FeishuBrand {
  return value?.trim().toLowerCase() === "lark" ? "lark" : "feishu";
}

export function hostsFor(brand: FeishuBrand): FeishuHosts {
  if (brand === "lark") {
    return {
      brand,
      accounts: "https://accounts.larksuite.com",
      open: "https://open.larksuite.com",
      docs: "https://www.larksuite.com",
    };
  }
  return {
    brand: "feishu",
    accounts: "https://accounts.feishu.cn",
    open: "https://open.feishu.cn",
    docs: "https://www.feishu.cn",
  };
}

/** App registration always starts on Feishu accounts, matching the official client. */
export const REGISTRATION_BEGIN_URL = "https://accounts.feishu.cn/oauth/v1/app/registration";

export function registrationPollUrl(brand: FeishuBrand): string {
  return `${hostsFor(brand).accounts}/oauth/v1/app/registration`;
}

export function deviceAuthorizationUrl(brand: FeishuBrand): string {
  return `${hostsFor(brand).accounts}/oauth/v1/device_authorization`;
}

export function tokenUrl(brand: FeishuBrand): string {
  return `${hostsFor(brand).accounts}/oauth/v3/token`;
}

export function authorizeUrl(brand: FeishuBrand, appId: string, redirectUri: string, state: string, scope: string): string {
  const url = new URL(`${hostsFor(brand).accounts}/open-apis/authen/v1/authorize`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scope);
  return url.toString();
}

export function callbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export const DEFAULT_CALLBACK_PORT = 9753;

const DOC_PATHS: Record<string, string> = {
  doc: "docs",
  docx: "docx",
  sheet: "sheets",
  bitable: "base",
  mindnote: "mindnotes",
  file: "file",
  folder: "drive/folder",
  slides: "slides",
  wiki: "wiki",
};

/** Fallback link when the metadata API does not return one. */
export function resourceUrl(brand: FeishuBrand, type: string, token: string): string {
  const kind = DOC_PATHS[type] ?? "docx";
  return `${hostsFor(brand).docs}/${kind}/${token}`;
}
