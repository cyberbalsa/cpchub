import type * as WebAuthn from "@simplewebauthn/browser";
export type BrowserWindow = Window &
  typeof globalThis & {
    SimpleWebAuthnBrowser?: Pick<
      typeof WebAuthn,
      "browserSupportsWebAuthn" | "startAuthentication" | "startRegistration"
    >;
    SwaggerUIBundle: (options: {
      url: string;
      dom_id: string;
      deepLinking: boolean;
      validatorUrl: null;
      persistAuthorization: boolean;
      supportedSubmitMethods: string[];
      requestInterceptor: (request: { url: string }) => { url: string };
    }) => unknown;
  };
