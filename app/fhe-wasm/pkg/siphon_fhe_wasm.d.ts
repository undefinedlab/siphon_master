/* tslint:disable */
/* eslint-disable */

export class Boolean {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static decompress_ciphertext(compressed_ciphertext: BooleanCompressedCiphertext): BooleanCiphertext;
    static decrypt(client_key: BooleanClientKey, ct: BooleanCiphertext): boolean;
    static deserialize_ciphertext(buffer: Uint8Array): BooleanCiphertext;
    static deserialize_client_key(buffer: Uint8Array): BooleanClientKey;
    static deserialize_compressed_ciphertext(buffer: Uint8Array): BooleanCompressedCiphertext;
    static deserialize_compressed_server_key(buffer: Uint8Array): BooleanCompressedServerKey;
    static deserialize_public_key(buffer: Uint8Array): BooleanPublicKey;
    static encrypt(client_key: BooleanClientKey, message: boolean): BooleanCiphertext;
    static encrypt_compressed(client_key: BooleanClientKey, message: boolean): BooleanCompressedCiphertext;
    static encrypt_with_public_key(public_key: BooleanPublicKey, message: boolean): BooleanCiphertext;
    static get_parameters(parameter_choice: number): BooleanParameters;
    static new_client_key(parameters: BooleanParameters): BooleanClientKey;
    static new_client_key_from_seed_and_parameters(seed_high_bytes: bigint, seed_low_bytes: bigint, parameters: BooleanParameters): BooleanClientKey;
    static new_compressed_server_key(client_key: BooleanClientKey): BooleanCompressedServerKey;
    static new_parameters(lwe_dimension: number, glwe_dimension: number, polynomial_size: number, lwe_modular_std_dev: number, glwe_modular_std_dev: number, pbs_base_log: number, pbs_level: number, ks_base_log: number, ks_level: number, encryption_key_choice: BooleanEncryptionKeyChoice): BooleanParameters;
    static new_public_key(client_key: BooleanClientKey): BooleanPublicKey;
    static serialize_ciphertext(ciphertext: BooleanCiphertext): Uint8Array;
    static serialize_client_key(client_key: BooleanClientKey): Uint8Array;
    static serialize_compressed_ciphertext(ciphertext: BooleanCompressedCiphertext): Uint8Array;
    static serialize_compressed_server_key(server_key: BooleanCompressedServerKey): Uint8Array;
    static serialize_public_key(public_key: BooleanPublicKey): Uint8Array;
    static trivial_encrypt(message: boolean): BooleanCiphertext;
}

export class BooleanCiphertext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class BooleanClientKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class BooleanCompressedCiphertext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class BooleanCompressedServerKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export enum BooleanEncryptionKeyChoice {
    Big = 0,
    Small = 1,
}

export enum BooleanParameterSet {
    Default = 0,
    TfheLib = 1,
    DefaultKsPbs = 2,
    TfheLibKsPbs = 3,
}

export class BooleanParameters {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class BooleanPublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class CompactFheBool {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheBool;
    static encrypt_with_compact_public_key(value: boolean, client_key: TfheCompactPublicKey): CompactFheBool;
    expand(): FheBool;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheBool;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheBoolList {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheBoolList;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheBoolList;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt10 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt10;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt10;
    expand(): FheInt10;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt10;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt10List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt10List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt12 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt12;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt12;
    expand(): FheInt12;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt12;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt128 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt128;
    static encrypt_with_compact_public_key(value: any, client_key: TfheCompactPublicKey): CompactFheInt128;
    expand(): FheInt128;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt128;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt128List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt128List;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheInt128List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt12List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt12List;
    static encrypt_with_compact_public_key(values: Int16Array, public_key: TfheCompactPublicKey): CompactFheInt12List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt14 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt14;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt14;
    expand(): FheInt14;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt14;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt14List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt14List;
    static encrypt_with_compact_public_key(values: Int16Array, public_key: TfheCompactPublicKey): CompactFheInt14List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt16 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt16;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt16;
    expand(): FheInt16;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt16;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt160 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt160;
    static encrypt_with_compact_public_key(value: any, client_key: TfheCompactPublicKey): CompactFheInt160;
    expand(): FheInt160;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt160;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt160List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt160List;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheInt160List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt16List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt16List;
    static encrypt_with_compact_public_key(values: Int16Array, public_key: TfheCompactPublicKey): CompactFheInt16List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt2;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt2;
    expand(): FheInt2;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt2;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt256 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt256;
    static encrypt_with_compact_public_key(value: any, client_key: TfheCompactPublicKey): CompactFheInt256;
    expand(): FheInt256;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt256;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt256List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt256List;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheInt256List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt2List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt2List;
    static encrypt_with_compact_public_key(values: Int8Array, public_key: TfheCompactPublicKey): CompactFheInt2List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt32;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt32;
    expand(): FheInt32;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt32;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt32List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt32List;
    static encrypt_with_compact_public_key(values: Int32Array, public_key: TfheCompactPublicKey): CompactFheInt32List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt4 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt4;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt4;
    expand(): FheInt4;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt4;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt4List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt4List;
    static encrypt_with_compact_public_key(values: Int8Array, public_key: TfheCompactPublicKey): CompactFheInt4List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt6 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt6;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt6;
    expand(): FheInt6;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt6;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt64;
    static encrypt_with_compact_public_key(value: bigint, client_key: TfheCompactPublicKey): CompactFheInt64;
    expand(): FheInt64;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt64;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt64List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt64List;
    static encrypt_with_compact_public_key(values: BigInt64Array, public_key: TfheCompactPublicKey): CompactFheInt64List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt6List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt6List;
    static encrypt_with_compact_public_key(values: Int8Array, public_key: TfheCompactPublicKey): CompactFheInt6List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheInt8 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt8;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheInt8;
    expand(): FheInt8;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheInt8;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheInt8List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheInt8List;
    static encrypt_with_compact_public_key(values: Int8Array, public_key: TfheCompactPublicKey): CompactFheInt8List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint10 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint10;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint10;
    expand(): FheUint10;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint10;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint10List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint10List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint12 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint12;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint12;
    expand(): FheUint12;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint12;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint128 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint128;
    static encrypt_with_compact_public_key(value: any, client_key: TfheCompactPublicKey): CompactFheUint128;
    expand(): FheUint128;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint128;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint128List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint128List;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheUint128List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint12List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint12List;
    static encrypt_with_compact_public_key(values: Uint16Array, public_key: TfheCompactPublicKey): CompactFheUint12List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint14 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint14;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint14;
    expand(): FheUint14;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint14;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint14List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint14List;
    static encrypt_with_compact_public_key(values: Uint16Array, public_key: TfheCompactPublicKey): CompactFheUint14List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint16 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint16;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint16;
    expand(): FheUint16;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint16;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint160 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint160;
    static encrypt_with_compact_public_key(value: any, client_key: TfheCompactPublicKey): CompactFheUint160;
    expand(): FheUint160;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint160;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint160List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint160List;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheUint160List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint16List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint16List;
    static encrypt_with_compact_public_key(values: Uint16Array, public_key: TfheCompactPublicKey): CompactFheUint16List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint2;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint2;
    expand(): FheUint2;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint2;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint256 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint256;
    static encrypt_with_compact_public_key(value: any, client_key: TfheCompactPublicKey): CompactFheUint256;
    expand(): FheUint256;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint256;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint256List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint256List;
    static encrypt_with_compact_public_key(values: any[], public_key: TfheCompactPublicKey): CompactFheUint256List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint2List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint2List;
    static encrypt_with_compact_public_key(values: Uint8Array, public_key: TfheCompactPublicKey): CompactFheUint2List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint32;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint32;
    expand(): FheUint32;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint32;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint32List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint32List;
    static encrypt_with_compact_public_key(values: Uint32Array, public_key: TfheCompactPublicKey): CompactFheUint32List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint4 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint4;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint4;
    expand(): FheUint4;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint4;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint4List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint4List;
    static encrypt_with_compact_public_key(values: Uint8Array, public_key: TfheCompactPublicKey): CompactFheUint4List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint6 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint6;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint6;
    expand(): FheUint6;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint6;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint64;
    static encrypt_with_compact_public_key(value: bigint, client_key: TfheCompactPublicKey): CompactFheUint64;
    expand(): FheUint64;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint64;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint64List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint64List;
    static encrypt_with_compact_public_key(values: BigUint64Array, public_key: TfheCompactPublicKey): CompactFheUint64List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint6List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint6List;
    static encrypt_with_compact_public_key(values: Uint8Array, public_key: TfheCompactPublicKey): CompactFheUint6List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompactFheUint8 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint8;
    static encrypt_with_compact_public_key(value: number, client_key: TfheCompactPublicKey): CompactFheUint8;
    expand(): FheUint8;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompactFheUint8;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompactFheUint8List {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): CompactFheUint8List;
    static encrypt_with_compact_public_key(values: Uint8Array, public_key: TfheCompactPublicKey): CompactFheUint8List;
    expand(): any[];
    serialize(): Uint8Array;
}

export class CompressedFheBool {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheBool;
    static deserialize(buffer: Uint8Array): CompressedFheBool;
    static encrypt_with_client_key(value: boolean, client_key: TfheClientKey): CompressedFheBool;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheBool;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt10 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt10;
    static deserialize(buffer: Uint8Array): CompressedFheInt10;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt10;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt10;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt12 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt12;
    static deserialize(buffer: Uint8Array): CompressedFheInt12;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt12;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt12;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt128 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt128;
    static deserialize(buffer: Uint8Array): CompressedFheInt128;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): CompressedFheInt128;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt128;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt14 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt14;
    static deserialize(buffer: Uint8Array): CompressedFheInt14;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt14;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt14;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt16 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt16;
    static deserialize(buffer: Uint8Array): CompressedFheInt16;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt16;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt16;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt160 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt160;
    static deserialize(buffer: Uint8Array): CompressedFheInt160;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): CompressedFheInt160;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt160;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt2;
    static deserialize(buffer: Uint8Array): CompressedFheInt2;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt2;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt2;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt256 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt256;
    static deserialize(buffer: Uint8Array): CompressedFheInt256;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): CompressedFheInt256;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt256;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt32;
    static deserialize(buffer: Uint8Array): CompressedFheInt32;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt32;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt32;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt4 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt4;
    static deserialize(buffer: Uint8Array): CompressedFheInt4;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt4;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt4;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt6 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt6;
    static deserialize(buffer: Uint8Array): CompressedFheInt6;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt6;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt6;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt64;
    static deserialize(buffer: Uint8Array): CompressedFheInt64;
    static encrypt_with_client_key(value: bigint, client_key: TfheClientKey): CompressedFheInt64;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt64;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheInt8 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheInt8;
    static deserialize(buffer: Uint8Array): CompressedFheInt8;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheInt8;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheInt8;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint10 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint10;
    static deserialize(buffer: Uint8Array): CompressedFheUint10;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint10;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint10;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint12 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint12;
    static deserialize(buffer: Uint8Array): CompressedFheUint12;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint12;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint12;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint128 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint128;
    static deserialize(buffer: Uint8Array): CompressedFheUint128;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): CompressedFheUint128;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint128;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint14 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint14;
    static deserialize(buffer: Uint8Array): CompressedFheUint14;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint14;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint14;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint16 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint16;
    static deserialize(buffer: Uint8Array): CompressedFheUint16;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint16;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint16;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint160 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint160;
    static deserialize(buffer: Uint8Array): CompressedFheUint160;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): CompressedFheUint160;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint160;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint2;
    static deserialize(buffer: Uint8Array): CompressedFheUint2;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint2;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint2;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint256 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint256;
    static deserialize(buffer: Uint8Array): CompressedFheUint256;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): CompressedFheUint256;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint256;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint32;
    static deserialize(buffer: Uint8Array): CompressedFheUint32;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint32;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint32;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint4 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint4;
    static deserialize(buffer: Uint8Array): CompressedFheUint4;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint4;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint4;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint6 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint6;
    static deserialize(buffer: Uint8Array): CompressedFheUint6;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint6;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint6;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint64;
    static deserialize(buffer: Uint8Array): CompressedFheUint64;
    static encrypt_with_client_key(value: bigint, client_key: TfheClientKey): CompressedFheUint64;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint64;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class CompressedFheUint8 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): FheUint8;
    static deserialize(buffer: Uint8Array): CompressedFheUint8;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): CompressedFheUint8;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): CompressedFheUint8;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheBool {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): boolean;
    static deserialize(buffer: Uint8Array): FheBool;
    static encrypt_with_client_key(value: boolean, client_key: TfheClientKey): FheBool;
    static encrypt_with_compact_public_key(value: boolean, compact_public_key: TfheCompactPublicKey): FheBool;
    static encrypt_with_compressed_public_key(value: boolean, compressed_public_key: TfheCompressedPublicKey): FheBool;
    static encrypt_with_public_key(value: boolean, public_key: TfhePublicKey): FheBool;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheBool;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt10 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt10;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt10;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt10;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt10;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt10;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt10;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt12 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt12;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt12;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt12;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt12;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt12;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt12;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt128 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): any;
    static deserialize(buffer: Uint8Array): FheInt128;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): FheInt128;
    static encrypt_with_compact_public_key(value: any, compact_public_key: TfheCompactPublicKey): FheInt128;
    static encrypt_with_compressed_public_key(value: any, compressed_public_key: TfheCompressedPublicKey): FheInt128;
    static encrypt_with_public_key(value: any, public_key: TfhePublicKey): FheInt128;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt128;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt14 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt14;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt14;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt14;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt14;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt14;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt14;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt16 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt16;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt16;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt16;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt16;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt16;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt16;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt160 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): any;
    static deserialize(buffer: Uint8Array): FheInt160;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): FheInt160;
    static encrypt_with_compact_public_key(value: any, compact_public_key: TfheCompactPublicKey): FheInt160;
    static encrypt_with_compressed_public_key(value: any, compressed_public_key: TfheCompressedPublicKey): FheInt160;
    static encrypt_with_public_key(value: any, public_key: TfhePublicKey): FheInt160;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt160;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt2;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt2;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt2;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt2;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt2;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt2;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt256 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): any;
    static deserialize(buffer: Uint8Array): FheInt256;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): FheInt256;
    static encrypt_with_compact_public_key(value: any, compact_public_key: TfheCompactPublicKey): FheInt256;
    static encrypt_with_compressed_public_key(value: any, compressed_public_key: TfheCompressedPublicKey): FheInt256;
    static encrypt_with_public_key(value: any, public_key: TfhePublicKey): FheInt256;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt256;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt32;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt32;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt32;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt32;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt32;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt32;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt4 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt4;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt4;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt4;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt4;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt4;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt4;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt6 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt6;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt6;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt6;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt6;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt6;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt6;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): bigint;
    static deserialize(buffer: Uint8Array): FheInt64;
    static encrypt_with_client_key(value: bigint, client_key: TfheClientKey): FheInt64;
    static encrypt_with_compact_public_key(value: bigint, compact_public_key: TfheCompactPublicKey): FheInt64;
    static encrypt_with_compressed_public_key(value: bigint, compressed_public_key: TfheCompressedPublicKey): FheInt64;
    static encrypt_with_public_key(value: bigint, public_key: TfhePublicKey): FheInt64;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt64;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheInt8 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheInt8;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheInt8;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheInt8;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheInt8;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheInt8;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheInt8;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint10 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint10;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint10;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint10;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint10;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint10;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint10;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint12 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint12;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint12;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint12;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint12;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint12;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint12;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint128 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): any;
    static deserialize(buffer: Uint8Array): FheUint128;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): FheUint128;
    static encrypt_with_compact_public_key(value: any, compact_public_key: TfheCompactPublicKey): FheUint128;
    static encrypt_with_compressed_public_key(value: any, compressed_public_key: TfheCompressedPublicKey): FheUint128;
    static encrypt_with_public_key(value: any, public_key: TfhePublicKey): FheUint128;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint128;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint14 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint14;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint14;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint14;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint14;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint14;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint14;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint16 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint16;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint16;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint16;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint16;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint16;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint16;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint160 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): any;
    static deserialize(buffer: Uint8Array): FheUint160;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): FheUint160;
    static encrypt_with_compact_public_key(value: any, compact_public_key: TfheCompactPublicKey): FheUint160;
    static encrypt_with_compressed_public_key(value: any, compressed_public_key: TfheCompressedPublicKey): FheUint160;
    static encrypt_with_public_key(value: any, public_key: TfhePublicKey): FheUint160;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint160;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint2 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint2;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint2;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint2;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint2;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint2;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint2;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint256 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): any;
    static deserialize(buffer: Uint8Array): FheUint256;
    static encrypt_with_client_key(value: any, client_key: TfheClientKey): FheUint256;
    static encrypt_with_compact_public_key(value: any, compact_public_key: TfheCompactPublicKey): FheUint256;
    static encrypt_with_compressed_public_key(value: any, compressed_public_key: TfheCompressedPublicKey): FheUint256;
    static encrypt_with_public_key(value: any, public_key: TfhePublicKey): FheUint256;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint256;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint32;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint32;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint32;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint32;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint32;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint32;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint4 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint4;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint4;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint4;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint4;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint4;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint4;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint6 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint6;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint6;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint6;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint6;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint6;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint6;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint64 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): bigint;
    static deserialize(buffer: Uint8Array): FheUint64;
    static encrypt_with_client_key(value: bigint, client_key: TfheClientKey): FheUint64;
    static encrypt_with_compact_public_key(value: bigint, compact_public_key: TfheCompactPublicKey): FheUint64;
    static encrypt_with_compressed_public_key(value: bigint, compressed_public_key: TfheCompressedPublicKey): FheUint64;
    static encrypt_with_public_key(value: bigint, public_key: TfhePublicKey): FheUint64;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint64;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class FheUint8 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decrypt(client_key: TfheClientKey): number;
    static deserialize(buffer: Uint8Array): FheUint8;
    static encrypt_with_client_key(value: number, client_key: TfheClientKey): FheUint8;
    static encrypt_with_compact_public_key(value: number, compact_public_key: TfheCompactPublicKey): FheUint8;
    static encrypt_with_compressed_public_key(value: number, compressed_public_key: TfheCompressedPublicKey): FheUint8;
    static encrypt_with_public_key(value: number, public_key: TfhePublicKey): FheUint8;
    static safe_deserialize(buffer: Uint8Array, serialized_size_limit: bigint): FheUint8;
    safe_serialize(serialized_size_limit: bigint): Uint8Array;
    serialize(): Uint8Array;
}

export class Shortint {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static decompress_ciphertext(compressed_ciphertext: ShortintCompressedCiphertext): ShortintCiphertext;
    static decrypt(client_key: ShortintClientKey, ct: ShortintCiphertext): bigint;
    static deserialize_ciphertext(buffer: Uint8Array): ShortintCiphertext;
    static deserialize_client_key(buffer: Uint8Array): ShortintClientKey;
    static deserialize_compressed_ciphertext(buffer: Uint8Array): ShortintCompressedCiphertext;
    static deserialize_compressed_public_key(buffer: Uint8Array): ShortintCompressedPublicKey;
    static deserialize_compressed_server_key(buffer: Uint8Array): ShortintCompressedServerKey;
    static deserialize_public_key(buffer: Uint8Array): ShortintPublicKey;
    static encrypt(client_key: ShortintClientKey, message: bigint): ShortintCiphertext;
    static encrypt_compressed(client_key: ShortintClientKey, message: bigint): ShortintCompressedCiphertext;
    static encrypt_with_compressed_public_key(public_key: ShortintCompressedPublicKey, message: bigint): ShortintCiphertext;
    static encrypt_with_public_key(public_key: ShortintPublicKey, message: bigint): ShortintCiphertext;
    static get_parameters(message_bits: number, carry_bits: number): ShortintParameters;
    static get_parameters_small(message_bits: number, carry_bits: number): ShortintParameters;
    static new_client_key(parameters: ShortintParameters): ShortintClientKey;
    static new_client_key_from_seed_and_parameters(seed_high_bytes: bigint, seed_low_bytes: bigint, parameters: ShortintParameters): ShortintClientKey;
    static new_compressed_public_key(client_key: ShortintClientKey): ShortintCompressedPublicKey;
    static new_compressed_server_key(client_key: ShortintClientKey): ShortintCompressedServerKey;
    static new_parameters(lwe_dimension: number, glwe_dimension: number, polynomial_size: number, lwe_modular_std_dev: number, glwe_modular_std_dev: number, pbs_base_log: number, pbs_level: number, ks_base_log: number, ks_level: number, message_modulus: number, carry_modulus: number, modulus_power_of_2_exponent: number, encryption_key_choice: ShortintEncryptionKeyChoice): ShortintParameters;
    static new_public_key(client_key: ShortintClientKey): ShortintPublicKey;
    static serialize_ciphertext(ciphertext: ShortintCiphertext): Uint8Array;
    static serialize_client_key(client_key: ShortintClientKey): Uint8Array;
    static serialize_compressed_ciphertext(ciphertext: ShortintCompressedCiphertext): Uint8Array;
    static serialize_compressed_public_key(public_key: ShortintCompressedPublicKey): Uint8Array;
    static serialize_compressed_server_key(server_key: ShortintCompressedServerKey): Uint8Array;
    static serialize_public_key(public_key: ShortintPublicKey): Uint8Array;
}

export class ShortintCiphertext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class ShortintClientKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class ShortintCompressedCiphertext {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class ShortintCompressedPublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class ShortintCompressedServerKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export enum ShortintEncryptionKeyChoice {
    Big = 0,
    Small = 1,
}

export class ShortintParameters {
    free(): void;
    [Symbol.dispose](): void;
    constructor(name: ShortintParametersName);
}

export enum ShortintParametersName {
    PARAM_MESSAGE_1_CARRY_0_KS_PBS = 0,
    PARAM_MESSAGE_1_CARRY_1_KS_PBS = 1,
    PARAM_MESSAGE_2_CARRY_0_KS_PBS = 2,
    PARAM_MESSAGE_1_CARRY_2_KS_PBS = 3,
    PARAM_MESSAGE_2_CARRY_1_KS_PBS = 4,
    PARAM_MESSAGE_3_CARRY_0_KS_PBS = 5,
    PARAM_MESSAGE_1_CARRY_3_KS_PBS = 6,
    PARAM_MESSAGE_2_CARRY_2_KS_PBS = 7,
    PARAM_MESSAGE_3_CARRY_1_KS_PBS = 8,
    PARAM_MESSAGE_4_CARRY_0_KS_PBS = 9,
    PARAM_MESSAGE_1_CARRY_4_KS_PBS = 10,
    PARAM_MESSAGE_2_CARRY_3_KS_PBS = 11,
    PARAM_MESSAGE_3_CARRY_2_KS_PBS = 12,
    PARAM_MESSAGE_4_CARRY_1_KS_PBS = 13,
    PARAM_MESSAGE_5_CARRY_0_KS_PBS = 14,
    PARAM_MESSAGE_1_CARRY_5_KS_PBS = 15,
    PARAM_MESSAGE_2_CARRY_4_KS_PBS = 16,
    PARAM_MESSAGE_3_CARRY_3_KS_PBS = 17,
    PARAM_MESSAGE_4_CARRY_2_KS_PBS = 18,
    PARAM_MESSAGE_5_CARRY_1_KS_PBS = 19,
    PARAM_MESSAGE_6_CARRY_0_KS_PBS = 20,
    PARAM_MESSAGE_1_CARRY_6_KS_PBS = 21,
    PARAM_MESSAGE_2_CARRY_5_KS_PBS = 22,
    PARAM_MESSAGE_3_CARRY_4_KS_PBS = 23,
    PARAM_MESSAGE_4_CARRY_3_KS_PBS = 24,
    PARAM_MESSAGE_5_CARRY_2_KS_PBS = 25,
    PARAM_MESSAGE_6_CARRY_1_KS_PBS = 26,
    PARAM_MESSAGE_7_CARRY_0_KS_PBS = 27,
    PARAM_MESSAGE_1_CARRY_7_KS_PBS = 28,
    PARAM_MESSAGE_2_CARRY_6_KS_PBS = 29,
    PARAM_MESSAGE_3_CARRY_5_KS_PBS = 30,
    PARAM_MESSAGE_4_CARRY_4_KS_PBS = 31,
    PARAM_MESSAGE_5_CARRY_3_KS_PBS = 32,
    PARAM_MESSAGE_6_CARRY_2_KS_PBS = 33,
    PARAM_MESSAGE_7_CARRY_1_KS_PBS = 34,
    PARAM_MESSAGE_8_CARRY_0_KS_PBS = 35,
    PARAM_MESSAGE_1_CARRY_1_PBS_KS = 36,
    PARAM_MESSAGE_2_CARRY_2_PBS_KS = 37,
    PARAM_MESSAGE_3_CARRY_3_PBS_KS = 38,
    PARAM_MESSAGE_4_CARRY_4_PBS_KS = 39,
    PARAM_MESSAGE_1_CARRY_2_COMPACT_PK_KS_PBS = 40,
    PARAM_MESSAGE_1_CARRY_3_COMPACT_PK_KS_PBS = 41,
    PARAM_MESSAGE_1_CARRY_4_COMPACT_PK_KS_PBS = 42,
    PARAM_MESSAGE_1_CARRY_5_COMPACT_PK_KS_PBS = 43,
    PARAM_MESSAGE_1_CARRY_6_COMPACT_PK_KS_PBS = 44,
    PARAM_MESSAGE_1_CARRY_7_COMPACT_PK_KS_PBS = 45,
    PARAM_MESSAGE_2_CARRY_1_COMPACT_PK_KS_PBS = 46,
    PARAM_MESSAGE_2_CARRY_2_COMPACT_PK_KS_PBS = 47,
    PARAM_MESSAGE_2_CARRY_3_COMPACT_PK_KS_PBS = 48,
    PARAM_MESSAGE_2_CARRY_4_COMPACT_PK_KS_PBS = 49,
    PARAM_MESSAGE_2_CARRY_5_COMPACT_PK_KS_PBS = 50,
    PARAM_MESSAGE_2_CARRY_6_COMPACT_PK_KS_PBS = 51,
    PARAM_MESSAGE_3_CARRY_1_COMPACT_PK_KS_PBS = 52,
    PARAM_MESSAGE_3_CARRY_2_COMPACT_PK_KS_PBS = 53,
    PARAM_MESSAGE_3_CARRY_3_COMPACT_PK_KS_PBS = 54,
    PARAM_MESSAGE_3_CARRY_4_COMPACT_PK_KS_PBS = 55,
    PARAM_MESSAGE_3_CARRY_5_COMPACT_PK_KS_PBS = 56,
    PARAM_MESSAGE_4_CARRY_1_COMPACT_PK_KS_PBS = 57,
    PARAM_MESSAGE_4_CARRY_2_COMPACT_PK_KS_PBS = 58,
    PARAM_MESSAGE_4_CARRY_3_COMPACT_PK_KS_PBS = 59,
    PARAM_MESSAGE_4_CARRY_4_COMPACT_PK_KS_PBS = 60,
    PARAM_MESSAGE_5_CARRY_1_COMPACT_PK_KS_PBS = 61,
    PARAM_MESSAGE_5_CARRY_2_COMPACT_PK_KS_PBS = 62,
    PARAM_MESSAGE_5_CARRY_3_COMPACT_PK_KS_PBS = 63,
    PARAM_MESSAGE_6_CARRY_1_COMPACT_PK_KS_PBS = 64,
    PARAM_MESSAGE_6_CARRY_2_COMPACT_PK_KS_PBS = 65,
    PARAM_MESSAGE_7_CARRY_1_COMPACT_PK_KS_PBS = 66,
    PARAM_MESSAGE_1_CARRY_1_COMPACT_PK_PBS_KS = 67,
    PARAM_MESSAGE_1_CARRY_2_COMPACT_PK_PBS_KS = 68,
    PARAM_MESSAGE_1_CARRY_3_COMPACT_PK_PBS_KS = 69,
    PARAM_MESSAGE_1_CARRY_4_COMPACT_PK_PBS_KS = 70,
    PARAM_MESSAGE_1_CARRY_5_COMPACT_PK_PBS_KS = 71,
    PARAM_MESSAGE_1_CARRY_6_COMPACT_PK_PBS_KS = 72,
    PARAM_MESSAGE_1_CARRY_7_COMPACT_PK_PBS_KS = 73,
    PARAM_MESSAGE_2_CARRY_1_COMPACT_PK_PBS_KS = 74,
    PARAM_MESSAGE_2_CARRY_2_COMPACT_PK_PBS_KS = 75,
    PARAM_MESSAGE_2_CARRY_3_COMPACT_PK_PBS_KS = 76,
    PARAM_MESSAGE_2_CARRY_4_COMPACT_PK_PBS_KS = 77,
    PARAM_MESSAGE_2_CARRY_5_COMPACT_PK_PBS_KS = 78,
    PARAM_MESSAGE_2_CARRY_6_COMPACT_PK_PBS_KS = 79,
    PARAM_MESSAGE_3_CARRY_1_COMPACT_PK_PBS_KS = 80,
    PARAM_MESSAGE_3_CARRY_2_COMPACT_PK_PBS_KS = 81,
    PARAM_MESSAGE_3_CARRY_3_COMPACT_PK_PBS_KS = 82,
    PARAM_MESSAGE_3_CARRY_4_COMPACT_PK_PBS_KS = 83,
    PARAM_MESSAGE_3_CARRY_5_COMPACT_PK_PBS_KS = 84,
    PARAM_MESSAGE_4_CARRY_1_COMPACT_PK_PBS_KS = 85,
    PARAM_MESSAGE_4_CARRY_2_COMPACT_PK_PBS_KS = 86,
    PARAM_MESSAGE_4_CARRY_3_COMPACT_PK_PBS_KS = 87,
    PARAM_MESSAGE_4_CARRY_4_COMPACT_PK_PBS_KS = 88,
    PARAM_MESSAGE_5_CARRY_1_COMPACT_PK_PBS_KS = 89,
    PARAM_MESSAGE_5_CARRY_2_COMPACT_PK_PBS_KS = 90,
    PARAM_MESSAGE_5_CARRY_3_COMPACT_PK_PBS_KS = 91,
    PARAM_MESSAGE_6_CARRY_1_COMPACT_PK_PBS_KS = 92,
    PARAM_MESSAGE_6_CARRY_2_COMPACT_PK_PBS_KS = 93,
    PARAM_MESSAGE_7_CARRY_1_COMPACT_PK_PBS_KS = 94,
    PARAM_MESSAGE_1_CARRY_0 = 95,
    PARAM_MESSAGE_1_CARRY_1 = 96,
    PARAM_MESSAGE_2_CARRY_0 = 97,
    PARAM_MESSAGE_1_CARRY_2 = 98,
    PARAM_MESSAGE_2_CARRY_1 = 99,
    PARAM_MESSAGE_3_CARRY_0 = 100,
    PARAM_MESSAGE_1_CARRY_3 = 101,
    PARAM_MESSAGE_2_CARRY_2 = 102,
    PARAM_MESSAGE_3_CARRY_1 = 103,
    PARAM_MESSAGE_4_CARRY_0 = 104,
    PARAM_MESSAGE_1_CARRY_4 = 105,
    PARAM_MESSAGE_2_CARRY_3 = 106,
    PARAM_MESSAGE_3_CARRY_2 = 107,
    PARAM_MESSAGE_4_CARRY_1 = 108,
    PARAM_MESSAGE_5_CARRY_0 = 109,
    PARAM_MESSAGE_1_CARRY_5 = 110,
    PARAM_MESSAGE_2_CARRY_4 = 111,
    PARAM_MESSAGE_3_CARRY_3 = 112,
    PARAM_MESSAGE_4_CARRY_2 = 113,
    PARAM_MESSAGE_5_CARRY_1 = 114,
    PARAM_MESSAGE_6_CARRY_0 = 115,
    PARAM_MESSAGE_1_CARRY_6 = 116,
    PARAM_MESSAGE_2_CARRY_5 = 117,
    PARAM_MESSAGE_3_CARRY_4 = 118,
    PARAM_MESSAGE_4_CARRY_3 = 119,
    PARAM_MESSAGE_5_CARRY_2 = 120,
    PARAM_MESSAGE_6_CARRY_1 = 121,
    PARAM_MESSAGE_7_CARRY_0 = 122,
    PARAM_MESSAGE_1_CARRY_7 = 123,
    PARAM_MESSAGE_2_CARRY_6 = 124,
    PARAM_MESSAGE_3_CARRY_5 = 125,
    PARAM_MESSAGE_4_CARRY_4 = 126,
    PARAM_MESSAGE_5_CARRY_3 = 127,
    PARAM_MESSAGE_6_CARRY_2 = 128,
    PARAM_MESSAGE_7_CARRY_1 = 129,
    PARAM_MESSAGE_8_CARRY_0 = 130,
    PARAM_SMALL_MESSAGE_1_CARRY_1 = 131,
    PARAM_SMALL_MESSAGE_2_CARRY_2 = 132,
    PARAM_SMALL_MESSAGE_3_CARRY_3 = 133,
    PARAM_SMALL_MESSAGE_4_CARRY_4 = 134,
}

export class ShortintPublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class TfheClientKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): TfheClientKey;
    static generate(config: TfheConfig): TfheClientKey;
    static generate_with_seed(config: TfheConfig, seed: any): TfheClientKey;
    serialize(): Uint8Array;
}

export class TfheCompactPublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): TfheCompactPublicKey;
    static new(client_key: TfheClientKey): TfheCompactPublicKey;
    serialize(): Uint8Array;
}

export class TfheCompressedCompactPublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): TfheCompactPublicKey;
    static deserialize(buffer: Uint8Array): TfheCompressedCompactPublicKey;
    static new(client_key: TfheClientKey): TfheCompressedCompactPublicKey;
    serialize(): Uint8Array;
}

export class TfheCompressedPublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    decompress(): TfhePublicKey;
    static deserialize(buffer: Uint8Array): TfheCompressedPublicKey;
    static new(client_key: TfheClientKey): TfheCompressedPublicKey;
    serialize(): Uint8Array;
}

export class TfheCompressedServerKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): TfheCompressedServerKey;
    static new(client_key: TfheClientKey): TfheCompressedServerKey;
    serialize(): Uint8Array;
}

export class TfheConfig {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class TfheConfigBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): TfheConfig;
    static default(): TfheConfigBuilder;
    static default_with_big_encryption(): TfheConfigBuilder;
    static default_with_small_encryption(): TfheConfigBuilder;
    use_custom_parameters(block_parameters: ShortintParameters): TfheConfigBuilder;
}

export class TfhePublicKey {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static deserialize(buffer: Uint8Array): TfhePublicKey;
    static new(client_key: TfheClientKey): TfhePublicKey;
    serialize(): Uint8Array;
}

/**
 * Decrypt an engine-produced result ciphertext. The engine encodes the trigger as 1/0,
 * matching the original server-side `client_key.decrypt::<u64>(ct) == 1`.
 */
export function decrypt_result(ciphertext_hex: string, client_key_hex: string): boolean;

/**
 * Derive the (compressed) server key from an existing client key. Deterministic, so the
 * browser only needs to persist the small client key and can re-derive the server key
 * whenever the backend needs it re-uploaded — avoids storing the ~20MB server key locally.
 */
export function derive_server_key(client_key_hex: string): string;

/**
 * Encrypt a price in cents (price * 100) with the given client key.
 * Returns the ciphertext as hex (bincode-serialized RadixCiphertext).
 */
export function encrypt_price(price_cents: bigint, client_key_hex: string): string;

/**
 * Generate a fresh FHE keypair. Returns `{ clientKey: hex, serverKey: hex }` where
 * serverKey is a *compressed* server key (the engine decompresses it before use).
 * Heavy: server-key generation is single-threaded on wasm.
 */
export function generate_keys(): any;

/**
 * DETERMINISTIC keygen. The same `seed_hex` always produces a BYTE-IDENTICAL ClientKey, so every
 * device / login / cleared-localStorage for one wallet regenerates the SAME client key — old
 * ciphertexts can never mismatch a re-synced key (the multi-device "Ca vs Cb" bug). fhe.ts derives
 * the seed from the wallet's deterministic ECDSA signature (keccak256(sig)); the first 16 bytes
 * become the u128 seed.
 *
 * Returns ONLY the client-key hex. The server key is re-derived on demand (`derive_server_key`);
 * since any server key derived from a given client key validly evaluates that client's ciphertexts,
 * building a compressed server key here would just waste the multi-second (single-threaded on wasm)
 * derivation, and its caller (fhe.ts getOrCreateClientKey) discards it anyway.
 */
export function generate_keys_from_seed(seed_hex: string): string;

export function init(): void;

export function init_panic_hook(): void;

export class tfhe {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}
