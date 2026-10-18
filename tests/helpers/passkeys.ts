import { Buffer } from "../../src/node-buffer";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest();
const encoded = (value: Uint8Array | string) =>
  Buffer.from(value).toString("base64url");
type Overrides = {
  origin?: string;
  rpID?: string;
  challenge?: string;
  flags?: number;
  counter?: number;
  crossOrigin?: boolean;
  userHandle?: string;
  invalidAttestation?: boolean;
};

// A software authenticator: real P-256 keys, CBOR attestation and signed assertions.
// Verification is never mocked; these responses pass through the production verifier.
export function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" }),
    id = randomBytes(32),
    idString = encoded(id);
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  let userHandle = "";
  function authData(rpID: string, flags: number, counter: number) {
    const tail = Buffer.alloc(5);
    tail[0] = flags;
    tail.writeUInt32BE(counter, 1);
    return Buffer.concat([digest(rpID), tail]);
  }
  return {
    id: idString,
    register(
      options: PublicKeyCredentialCreationOptionsJSON,
      overrides: Overrides = {},
    ): RegistrationResponseJSON {
      userHandle = options.user.id;
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const data = Buffer.concat([
        authData(
          overrides.rpID || options.rp.id!,
          overrides.flags ?? 0x45,
          overrides.counter ?? 0,
        ),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      const clientData = JSON.stringify({
        type: "webauthn.create",
        challenge: overrides.challenge || options.challenge,
        origin: overrides.origin || "https://cpchub.net",
        crossOrigin: overrides.crossOrigin ?? false,
      });
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, number | Uint8Array>>(
          [
            ["fmt", overrides.invalidAttestation ? "packed" : "none"],
            [
              "attStmt",
              overrides.invalidAttestation
                ? new Map<string, number | Uint8Array>([
                    ["alg", -7],
                    [
                      "sig",
                      sign(
                        "sha256",
                        Buffer.from("different signed data"),
                        privateKey,
                      ),
                    ],
                  ])
                : new Map<string, number | Uint8Array>(),
            ],
            ["authData", data],
          ],
        ),
      );
      return {
        id: idString,
        rawId: idString,
        type: "public-key",
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: encoded(clientData),
          attestationObject: encoded(attestation),
          transports: ["internal"],
        },
      };
    },
    authenticate(
      options: PublicKeyCredentialRequestOptionsJSON,
      overrides: Overrides = {},
    ): AuthenticationResponseJSON {
      const client = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: overrides.challenge || options.challenge,
          origin: overrides.origin || "https://cpchub.net",
          crossOrigin: overrides.crossOrigin ?? false,
        }),
      );
      const data = authData(
        overrides.rpID || options.rpId!,
        overrides.flags ?? 5,
        overrides.counter ?? 1,
      );
      return {
        id: idString,
        rawId: idString,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: encoded(client),
          authenticatorData: encoded(data),
          signature: encoded(
            sign("sha256", Buffer.concat([data, digest(client)]), privateKey),
          ),
          userHandle: overrides.userHandle ?? userHandle,
        },
      };
    },
  };
}
