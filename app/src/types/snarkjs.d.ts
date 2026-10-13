declare module "snarkjs" {
  interface Groth16Proof {
    pi_a: [string, string, string?];
    pi_b: [[string, string], [string, string], [string, string]?];
    pi_c: [string, string, string?];
    protocol?: string;
    curve?: string;
  }

  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      // Node snarkjs uses fs.open on string paths — pass Uint8Array for remote S3 wasm (pipeline TEE).
      wasmFile: string | Uint8Array,
      // fastfile's readExisting takes a URL to fetch OR the bytes themselves; in the browser the
      // URL path fetches the whole file into memory anyway, so bytes lose nothing. We pass bytes
      // when the proving key is already in Cache Storage — see zkeyCache.
      zkeyFile: string | Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}
