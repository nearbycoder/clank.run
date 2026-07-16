export interface PasskeyRegistrationCredential {
    id: string;
    rawId: string;
    type: "public-key";
    response: {
        clientDataJSON: string;
        attestationObject: string;
        transports?: readonly string[];
    };
}
export interface PasskeyAuthenticationCredential {
    id: string;
    rawId: string;
    type: "public-key";
    response: {
        clientDataJSON: string;
        authenticatorData: string;
        signature: string;
        userHandle?: string | null;
    };
}
export interface StoredPasskey {
    credentialId: string;
    publicKey: JsonWebKey;
    algorithm: number;
    counter: number;
    transports: readonly string[];
}
export interface VerifiedPasskeyAuthentication {
    counter: number;
    userVerified: boolean;
}
export interface PublicKeyCredentialCreationOptionsJSON {
    challenge: string;
    rp: {
        id: string;
        name: string;
    };
    user: {
        id: string;
        name: string;
        displayName: string;
    };
    pubKeyCredParams: readonly {
        type: "public-key";
        alg: number;
    }[];
    timeout: number;
    attestation: "none";
    authenticatorSelection: {
        residentKey: "preferred";
        userVerification: "preferred" | "required";
    };
    excludeCredentials: readonly PublicKeyCredentialDescriptorJSON[];
}
export interface PublicKeyCredentialRequestOptionsJSON {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: "preferred" | "required";
    allowCredentials: readonly PublicKeyCredentialDescriptorJSON[];
}
export interface PublicKeyCredentialDescriptorJSON {
    type: "public-key";
    id: string;
    transports?: readonly string[];
}
export declare function passkeyRegistrationOptions(input: {
    challenge: string;
    rpId: string;
    rpName: string;
    userId: string;
    userName: string;
    userDisplayName: string;
    excludeCredentialIds?: readonly string[];
    timeoutMs?: number;
    requireUserVerification?: boolean;
}): PublicKeyCredentialCreationOptionsJSON;
export declare function passkeyAuthenticationOptions(input: {
    challenge: string;
    rpId: string;
    credentialIds: readonly {
        id: string;
        transports?: readonly string[];
    }[];
    timeoutMs?: number;
    requireUserVerification?: boolean;
}): PublicKeyCredentialRequestOptionsJSON;
export declare function verifyPasskeyRegistration(input: {
    credential: PasskeyRegistrationCredential;
    challenge: string;
    origin: string;
    rpId: string;
    requireUserVerification?: boolean;
}): Promise<StoredPasskey>;
export declare function verifyPasskeyAuthentication(input: {
    credential: PasskeyAuthenticationCredential;
    challenge: string;
    origin: string;
    rpId: string;
    stored: StoredPasskey;
    requireUserVerification?: boolean;
}): Promise<VerifiedPasskeyAuthentication>;
export declare function serializeRegistrationCredential(credential: PublicKeyCredential): PasskeyRegistrationCredential;
export declare function serializeAuthenticationCredential(credential: PublicKeyCredential): PasskeyAuthenticationCredential;
export declare function registrationOptionsForBrowser(options: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions;
export declare function authenticationOptionsForBrowser(options: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions;
