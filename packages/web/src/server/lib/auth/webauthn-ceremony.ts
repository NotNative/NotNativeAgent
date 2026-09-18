// SPDX-License-Identifier: Apache-2.0
/**
 * WebAuthnCeremony seam (doc 08 section 2.4): the passkey controller is
 * ceremony-agnostic; production always rides this real adapter over
 * @simplewebauthn/server, while tests may inject fixtures. The lib's
 * generated typings pin `Uint8Array<ArrayBuffer>` and a JSON-shaped
 * credential store, so the seam converts each way exactly once.
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

export interface CeremonyAdapter {
  registrationOptions(input: {
    rpName: string; rpID: string; userID: Uint8Array; userName: string;
    attestationType: 'none'; excludeCredentials: { id: string; transports?: string[] }[];
    authenticatorSelection: { residentKey: 'required'; userVerification: 'required' };
  }): Promise<unknown>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON; expectedChallenge: string; expectedOrigin: string[];
    expectedRPID: string; requireUserVerification: true;
  }): Promise<RegistrationVerification>;
  authenticationOptions(input: {
    rpID: string; allowCredentials: { id: string; transports?: string[] }[];
    userVerification: 'required';
  }): Promise<unknown>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON; expectedChallenge: string; expectedOrigin: string[];
    expectedRPID: string; requireUserVerification: true;
    credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
  }): Promise<AuthenticationVerification>;
}

export interface RegistrationVerification {
  verified: boolean;
  registrationInfo?: {
    credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
    credentialDeviceType: string;
    credentialBackedUp: boolean;
  };
}

export interface AuthenticationVerification {
  verified: boolean;
  authenticationInfo?: {
    newCounter: number;
    userVerified: boolean;
  };
}

export const realCeremony: CeremonyAdapter = {
  registrationOptions: async (input) => generateRegistrationOptions({ ...input, userID: new Uint8Array(input.userID) } as never),
  verifyRegistration: async (input) => await verifyRegistrationResponse(input as never) as unknown as RegistrationVerification,
  authenticationOptions: async (input) => generateAuthenticationOptions(input as never),
  verifyAuthentication: async (input) => await verifyAuthenticationResponse({
    ...input,
    credential: { ...input.credential, publicKey: new Uint8Array(input.credential.publicKey) },
  } as never) as unknown as AuthenticationVerification,
};
