export class Boolean {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_boolean_free(ptr, 0);
    }
    /**
     * @param {BooleanCompressedCiphertext} compressed_ciphertext
     * @returns {BooleanCiphertext}
     */
    static decompress_ciphertext(compressed_ciphertext) {
        _assertClass(compressed_ciphertext, BooleanCompressedCiphertext);
        const ret = wasm.boolean_decompress_ciphertext(compressed_ciphertext.__wbg_ptr);
        return BooleanCiphertext.__wrap(ret);
    }
    /**
     * @param {BooleanClientKey} client_key
     * @param {BooleanCiphertext} ct
     * @returns {boolean}
     */
    static decrypt(client_key, ct) {
        _assertClass(client_key, BooleanClientKey);
        _assertClass(ct, BooleanCiphertext);
        const ret = wasm.boolean_decrypt(client_key.__wbg_ptr, ct.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {BooleanCiphertext}
     */
    static deserialize_ciphertext(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.boolean_deserialize_ciphertext(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BooleanCiphertext.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {BooleanClientKey}
     */
    static deserialize_client_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.boolean_deserialize_client_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BooleanClientKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {BooleanCompressedCiphertext}
     */
    static deserialize_compressed_ciphertext(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.boolean_deserialize_compressed_ciphertext(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BooleanCompressedCiphertext.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {BooleanCompressedServerKey}
     */
    static deserialize_compressed_server_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.boolean_deserialize_compressed_server_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BooleanCompressedServerKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {BooleanPublicKey}
     */
    static deserialize_public_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.boolean_deserialize_public_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BooleanPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {BooleanClientKey} client_key
     * @param {boolean} message
     * @returns {BooleanCiphertext}
     */
    static encrypt(client_key, message) {
        _assertClass(client_key, BooleanClientKey);
        const ret = wasm.boolean_encrypt(client_key.__wbg_ptr, message);
        return BooleanCiphertext.__wrap(ret);
    }
    /**
     * @param {BooleanClientKey} client_key
     * @param {boolean} message
     * @returns {BooleanCompressedCiphertext}
     */
    static encrypt_compressed(client_key, message) {
        _assertClass(client_key, BooleanClientKey);
        const ret = wasm.boolean_encrypt_compressed(client_key.__wbg_ptr, message);
        return BooleanCompressedCiphertext.__wrap(ret);
    }
    /**
     * @param {BooleanPublicKey} public_key
     * @param {boolean} message
     * @returns {BooleanCiphertext}
     */
    static encrypt_with_public_key(public_key, message) {
        _assertClass(public_key, BooleanPublicKey);
        const ret = wasm.boolean_encrypt_with_public_key(public_key.__wbg_ptr, message);
        return BooleanCiphertext.__wrap(ret);
    }
    /**
     * @param {number} parameter_choice
     * @returns {BooleanParameters}
     */
    static get_parameters(parameter_choice) {
        const ret = wasm.boolean_get_parameters(parameter_choice);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BooleanParameters.__wrap(ret[0]);
    }
    /**
     * @param {BooleanParameters} parameters
     * @returns {BooleanClientKey}
     */
    static new_client_key(parameters) {
        _assertClass(parameters, BooleanParameters);
        const ret = wasm.boolean_new_client_key(parameters.__wbg_ptr);
        return BooleanClientKey.__wrap(ret);
    }
    /**
     * @param {bigint} seed_high_bytes
     * @param {bigint} seed_low_bytes
     * @param {BooleanParameters} parameters
     * @returns {BooleanClientKey}
     */
    static new_client_key_from_seed_and_parameters(seed_high_bytes, seed_low_bytes, parameters) {
        _assertClass(parameters, BooleanParameters);
        const ret = wasm.boolean_new_client_key_from_seed_and_parameters(seed_high_bytes, seed_low_bytes, parameters.__wbg_ptr);
        return BooleanClientKey.__wrap(ret);
    }
    /**
     * @param {BooleanClientKey} client_key
     * @returns {BooleanCompressedServerKey}
     */
    static new_compressed_server_key(client_key) {
        _assertClass(client_key, BooleanClientKey);
        const ret = wasm.boolean_new_compressed_server_key(client_key.__wbg_ptr);
        return BooleanCompressedServerKey.__wrap(ret);
    }
    /**
     * @param {number} lwe_dimension
     * @param {number} glwe_dimension
     * @param {number} polynomial_size
     * @param {number} lwe_modular_std_dev
     * @param {number} glwe_modular_std_dev
     * @param {number} pbs_base_log
     * @param {number} pbs_level
     * @param {number} ks_base_log
     * @param {number} ks_level
     * @param {BooleanEncryptionKeyChoice} encryption_key_choice
     * @returns {BooleanParameters}
     */
    static new_parameters(lwe_dimension, glwe_dimension, polynomial_size, lwe_modular_std_dev, glwe_modular_std_dev, pbs_base_log, pbs_level, ks_base_log, ks_level, encryption_key_choice) {
        const ret = wasm.boolean_new_parameters(lwe_dimension, glwe_dimension, polynomial_size, lwe_modular_std_dev, glwe_modular_std_dev, pbs_base_log, pbs_level, ks_base_log, ks_level, encryption_key_choice);
        return BooleanParameters.__wrap(ret);
    }
    /**
     * @param {BooleanClientKey} client_key
     * @returns {BooleanPublicKey}
     */
    static new_public_key(client_key) {
        _assertClass(client_key, BooleanClientKey);
        const ret = wasm.boolean_new_public_key(client_key.__wbg_ptr);
        return BooleanPublicKey.__wrap(ret);
    }
    /**
     * @param {BooleanCiphertext} ciphertext
     * @returns {Uint8Array}
     */
    static serialize_ciphertext(ciphertext) {
        _assertClass(ciphertext, BooleanCiphertext);
        const ret = wasm.boolean_serialize_ciphertext(ciphertext.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {BooleanClientKey} client_key
     * @returns {Uint8Array}
     */
    static serialize_client_key(client_key) {
        _assertClass(client_key, BooleanClientKey);
        const ret = wasm.boolean_serialize_client_key(client_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {BooleanCompressedCiphertext} ciphertext
     * @returns {Uint8Array}
     */
    static serialize_compressed_ciphertext(ciphertext) {
        _assertClass(ciphertext, BooleanCompressedCiphertext);
        const ret = wasm.boolean_serialize_compressed_ciphertext(ciphertext.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {BooleanCompressedServerKey} server_key
     * @returns {Uint8Array}
     */
    static serialize_compressed_server_key(server_key) {
        _assertClass(server_key, BooleanCompressedServerKey);
        const ret = wasm.boolean_serialize_compressed_server_key(server_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {BooleanPublicKey} public_key
     * @returns {Uint8Array}
     */
    static serialize_public_key(public_key) {
        _assertClass(public_key, BooleanPublicKey);
        const ret = wasm.boolean_serialize_public_key(public_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {boolean} message
     * @returns {BooleanCiphertext}
     */
    static trivial_encrypt(message) {
        const ret = wasm.boolean_trivial_encrypt(message);
        return BooleanCiphertext.__wrap(ret);
    }
}
if (Symbol.dispose) Boolean.prototype[Symbol.dispose] = Boolean.prototype.free;

export class BooleanCiphertext {
    static __wrap(ptr) {
        const obj = Object.create(BooleanCiphertext.prototype);
        obj.__wbg_ptr = ptr;
        BooleanCiphertextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanCiphertextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_booleanciphertext_free(ptr, 0);
    }
}
if (Symbol.dispose) BooleanCiphertext.prototype[Symbol.dispose] = BooleanCiphertext.prototype.free;

export class BooleanClientKey {
    static __wrap(ptr) {
        const obj = Object.create(BooleanClientKey.prototype);
        obj.__wbg_ptr = ptr;
        BooleanClientKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanClientKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_booleanclientkey_free(ptr, 0);
    }
}
if (Symbol.dispose) BooleanClientKey.prototype[Symbol.dispose] = BooleanClientKey.prototype.free;

export class BooleanCompressedCiphertext {
    static __wrap(ptr) {
        const obj = Object.create(BooleanCompressedCiphertext.prototype);
        obj.__wbg_ptr = ptr;
        BooleanCompressedCiphertextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanCompressedCiphertextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_booleancompressedciphertext_free(ptr, 0);
    }
}
if (Symbol.dispose) BooleanCompressedCiphertext.prototype[Symbol.dispose] = BooleanCompressedCiphertext.prototype.free;

export class BooleanCompressedServerKey {
    static __wrap(ptr) {
        const obj = Object.create(BooleanCompressedServerKey.prototype);
        obj.__wbg_ptr = ptr;
        BooleanCompressedServerKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanCompressedServerKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_booleancompressedserverkey_free(ptr, 0);
    }
}
if (Symbol.dispose) BooleanCompressedServerKey.prototype[Symbol.dispose] = BooleanCompressedServerKey.prototype.free;

/**
 * @enum {0 | 1}
 */
export const BooleanEncryptionKeyChoice = Object.freeze({
    Big: 0, "0": "Big",
    Small: 1, "1": "Small",
});

/**
 * @enum {0 | 1 | 2 | 3}
 */
export const BooleanParameterSet = Object.freeze({
    Default: 0, "0": "Default",
    TfheLib: 1, "1": "TfheLib",
    DefaultKsPbs: 2, "2": "DefaultKsPbs",
    TfheLibKsPbs: 3, "3": "TfheLibKsPbs",
});

export class BooleanParameters {
    static __wrap(ptr) {
        const obj = Object.create(BooleanParameters.prototype);
        obj.__wbg_ptr = ptr;
        BooleanParametersFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanParametersFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_booleanparameters_free(ptr, 0);
    }
}
if (Symbol.dispose) BooleanParameters.prototype[Symbol.dispose] = BooleanParameters.prototype.free;

export class BooleanPublicKey {
    static __wrap(ptr) {
        const obj = Object.create(BooleanPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        BooleanPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BooleanPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_booleanpublickey_free(ptr, 0);
    }
}
if (Symbol.dispose) BooleanPublicKey.prototype[Symbol.dispose] = BooleanPublicKey.prototype.free;

export class CompactFheBool {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheBool.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheBoolFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheBoolFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfhebool_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheBool}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfhebool_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheBool.__wrap(ret[0]);
    }
    /**
     * @param {boolean} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheBool}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfhebool_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheBool.__wrap(ret[0]);
    }
    /**
     * @returns {FheBool}
     */
    expand() {
        const ret = wasm.compactfhebool_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheBool}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfhebool_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheBool.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfhebool_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfhebool_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheBool.prototype[Symbol.dispose] = CompactFheBool.prototype.free;

export class CompactFheBoolList {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheBoolList.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheBoolListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheBoolListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheboollist_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheBoolList}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheboollist_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheBoolList.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheBoolList}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheboollist_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheBoolList.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheboollist_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheboollist_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheBoolList.prototype[Symbol.dispose] = CompactFheBoolList.prototype.free;

export class CompactFheInt10 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt10.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt10Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt10Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint10_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt10}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint10_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt10}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint10_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt10.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt10}
     */
    expand() {
        const ret = wasm.compactfheint10_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt10}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint10_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt10.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint10_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint10_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt10.prototype[Symbol.dispose] = CompactFheInt10.prototype.free;

export class CompactFheInt10List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt10List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt10ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt10ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint10list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt10List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint10list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt10List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint10list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint10list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt10List.prototype[Symbol.dispose] = CompactFheInt10List.prototype.free;

export class CompactFheInt12 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt12.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt12Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt12Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint12_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt12}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint12_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt12}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint12_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt12.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt12}
     */
    expand() {
        const ret = wasm.compactfheint12_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt12}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint12_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt12.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint12_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint12_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt12.prototype[Symbol.dispose] = CompactFheInt12.prototype.free;

export class CompactFheInt128 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt128.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt128Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt128Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint128_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt128}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint128_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt128}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint128_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt128.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt128}
     */
    expand() {
        const ret = wasm.compactfheint128_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt128}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint128_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt128.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint128_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint128_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt128.prototype[Symbol.dispose] = CompactFheInt128.prototype.free;

export class CompactFheInt128List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt128List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt128ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt128ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint128list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt128List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint128list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt128List.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt128List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint128list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt128List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint128list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint128list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt128List.prototype[Symbol.dispose] = CompactFheInt128List.prototype.free;

export class CompactFheInt12List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt12List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt12ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt12ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint12list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt12List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint12list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt12List.__wrap(ret[0]);
    }
    /**
     * @param {Int16Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt12List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray16ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint12list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt12List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint12list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint12list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt12List.prototype[Symbol.dispose] = CompactFheInt12List.prototype.free;

export class CompactFheInt14 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt14.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt14Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt14Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint14_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt14}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint14_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt14}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint14_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt14.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt14}
     */
    expand() {
        const ret = wasm.compactfheint14_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt14}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint14_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt14.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint14_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint14_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt14.prototype[Symbol.dispose] = CompactFheInt14.prototype.free;

export class CompactFheInt14List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt14List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt14ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt14ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint14list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt14List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint14list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt14List.__wrap(ret[0]);
    }
    /**
     * @param {Int16Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt14List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray16ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint14list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt14List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint14list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint14list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt14List.prototype[Symbol.dispose] = CompactFheInt14List.prototype.free;

export class CompactFheInt16 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt16.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt16Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt16Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint16_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt16}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint16_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt16}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint16_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt16.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt16}
     */
    expand() {
        const ret = wasm.compactfheint16_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt16}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint16_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt16.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint16_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint16_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt16.prototype[Symbol.dispose] = CompactFheInt16.prototype.free;

export class CompactFheInt160 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt160.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt160Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt160Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint160_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt160}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint160_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt160}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint160_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt160.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt160}
     */
    expand() {
        const ret = wasm.compactfheint160_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt160}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint160_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt160.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint160_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint160_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt160.prototype[Symbol.dispose] = CompactFheInt160.prototype.free;

export class CompactFheInt160List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt160List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt160ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt160ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint160list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt160List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint160list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt160List.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt160List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint160list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt160List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint160list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint160list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt160List.prototype[Symbol.dispose] = CompactFheInt160List.prototype.free;

export class CompactFheInt16List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt16List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt16ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt16ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint16list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt16List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint16list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt16List.__wrap(ret[0]);
    }
    /**
     * @param {Int16Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt16List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray16ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint16list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt16List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint16list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint16list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt16List.prototype[Symbol.dispose] = CompactFheInt16List.prototype.free;

export class CompactFheInt2 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt2.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt2Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt2Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint2_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt2}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint2_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt2}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint2_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt2.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt2}
     */
    expand() {
        const ret = wasm.compactfheint2_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt2}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint2_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt2.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint2_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint2_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt2.prototype[Symbol.dispose] = CompactFheInt2.prototype.free;

export class CompactFheInt256 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt256.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt256Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt256Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint256_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt256}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint256_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt256}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint256_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt256.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt256}
     */
    expand() {
        const ret = wasm.compactfheint256_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt256}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint256_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt256.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint256_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint256_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt256.prototype[Symbol.dispose] = CompactFheInt256.prototype.free;

export class CompactFheInt256List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt256List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt256ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt256ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint256list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt256List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint256list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt256List.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt256List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint256list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt256List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint256list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint256list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt256List.prototype[Symbol.dispose] = CompactFheInt256List.prototype.free;

export class CompactFheInt2List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt2List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt2ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt2ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint2list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt2List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint2list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt2List.__wrap(ret[0]);
    }
    /**
     * @param {Int8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt2List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint2list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt2List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint2list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint2list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt2List.prototype[Symbol.dispose] = CompactFheInt2List.prototype.free;

export class CompactFheInt32 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt32.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint32_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt32}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint32_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt32}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint32_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt32.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt32}
     */
    expand() {
        const ret = wasm.compactfheint32_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt32}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint32_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt32.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint32_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint32_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt32.prototype[Symbol.dispose] = CompactFheInt32.prototype.free;

export class CompactFheInt32List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt32List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt32ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt32ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint32list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt32List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint32list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt32List.__wrap(ret[0]);
    }
    /**
     * @param {Int32Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt32List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint32list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt32List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint32list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint32list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt32List.prototype[Symbol.dispose] = CompactFheInt32List.prototype.free;

export class CompactFheInt4 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt4.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt4Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt4Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint4_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt4}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint4_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt4}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint4_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt4.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt4}
     */
    expand() {
        const ret = wasm.compactfheint4_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt4}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint4_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt4.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint4_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint4_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt4.prototype[Symbol.dispose] = CompactFheInt4.prototype.free;

export class CompactFheInt4List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt4List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt4ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt4ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint4list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt4List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint4list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt4List.__wrap(ret[0]);
    }
    /**
     * @param {Int8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt4List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint4list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt4List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint4list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint4list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt4List.prototype[Symbol.dispose] = CompactFheInt4List.prototype.free;

export class CompactFheInt6 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt6.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt6Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt6Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint6_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt6}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint6_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt6}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint6_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt6.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt6}
     */
    expand() {
        const ret = wasm.compactfheint6_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt6}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint6_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt6.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint6_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint6_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt6.prototype[Symbol.dispose] = CompactFheInt6.prototype.free;

export class CompactFheInt64 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt64.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint64_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt64}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint64_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt64}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint64_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt64.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt64}
     */
    expand() {
        const ret = wasm.compactfheint64_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt64}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint64_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint64_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint64_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt64.prototype[Symbol.dispose] = CompactFheInt64.prototype.free;

export class CompactFheInt64List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt64List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt64ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt64ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint64list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt64List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint64list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt64List.__wrap(ret[0]);
    }
    /**
     * @param {BigInt64Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt64List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray64ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint64list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt64List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint64list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint64list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt64List.prototype[Symbol.dispose] = CompactFheInt64List.prototype.free;

export class CompactFheInt6List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt6List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt6ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt6ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint6list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt6List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint6list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt6List.__wrap(ret[0]);
    }
    /**
     * @param {Int8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt6List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint6list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt6List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint6list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint6list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt6List.prototype[Symbol.dispose] = CompactFheInt6List.prototype.free;

export class CompactFheInt8 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt8.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt8Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint8_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt8}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint8_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheInt8}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint8_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt8.__wrap(ret[0]);
    }
    /**
     * @returns {FheInt8}
     */
    expand() {
        const ret = wasm.compactfheint8_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheInt8}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint8_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt8.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheint8_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint8_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt8.prototype[Symbol.dispose] = CompactFheInt8.prototype.free;

export class CompactFheInt8List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheInt8List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheInt8ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheInt8ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheint8list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheInt8List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheint8list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt8List.__wrap(ret[0]);
    }
    /**
     * @param {Int8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheInt8List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheint8list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheInt8List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheint8list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheint8list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheInt8List.prototype[Symbol.dispose] = CompactFheInt8List.prototype.free;

export class CompactFheUint10 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint10.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint10Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint10Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint10_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint10}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint10_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint10}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint10_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint10.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint10}
     */
    expand() {
        const ret = wasm.compactfheuint10_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint10}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint10_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint10.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint10_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint10_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint10.prototype[Symbol.dispose] = CompactFheUint10.prototype.free;

export class CompactFheUint10List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint10List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint10ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint10ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint10list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint10List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint10list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint10List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint10list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint10list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint10List.prototype[Symbol.dispose] = CompactFheUint10List.prototype.free;

export class CompactFheUint12 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint12.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint12Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint12Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint12_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint12}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint12_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint12}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint12_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint12.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint12}
     */
    expand() {
        const ret = wasm.compactfheuint12_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint12}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint12_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint12.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint12_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint12_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint12.prototype[Symbol.dispose] = CompactFheUint12.prototype.free;

export class CompactFheUint128 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint128.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint128Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint128Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint128_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint128}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint128_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint128}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint128_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint128.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint128}
     */
    expand() {
        const ret = wasm.compactfheuint128_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint128}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint128_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint128.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint128_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint128_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint128.prototype[Symbol.dispose] = CompactFheUint128.prototype.free;

export class CompactFheUint128List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint128List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint128ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint128ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint128list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint128List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint128list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint128List.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint128List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint128list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint128List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint128list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint128list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint128List.prototype[Symbol.dispose] = CompactFheUint128List.prototype.free;

export class CompactFheUint12List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint12List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint12ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint12ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint12list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint12List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint12list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint12List.__wrap(ret[0]);
    }
    /**
     * @param {Uint16Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint12List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray16ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint12list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint12List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint12list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint12list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint12List.prototype[Symbol.dispose] = CompactFheUint12List.prototype.free;

export class CompactFheUint14 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint14.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint14Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint14Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint14_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint14}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint14_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint14}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint14_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint14.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint14}
     */
    expand() {
        const ret = wasm.compactfheuint14_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint14}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint14_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint14.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint14_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint14_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint14.prototype[Symbol.dispose] = CompactFheUint14.prototype.free;

export class CompactFheUint14List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint14List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint14ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint14ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint14list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint14List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint14list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint14List.__wrap(ret[0]);
    }
    /**
     * @param {Uint16Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint14List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray16ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint14list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint14List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint14list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint14list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint14List.prototype[Symbol.dispose] = CompactFheUint14List.prototype.free;

export class CompactFheUint16 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint16.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint16Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint16Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint16_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint16}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint16_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint16}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint16_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint16.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint16}
     */
    expand() {
        const ret = wasm.compactfheuint16_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint16}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint16_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint16.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint16_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint16_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint16.prototype[Symbol.dispose] = CompactFheUint16.prototype.free;

export class CompactFheUint160 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint160.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint160Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint160Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint160_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint160}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint160_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint160}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint160_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint160.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint160}
     */
    expand() {
        const ret = wasm.compactfheuint160_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint160}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint160_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint160.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint160_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint160_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint160.prototype[Symbol.dispose] = CompactFheUint160.prototype.free;

export class CompactFheUint160List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint160List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint160ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint160ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint160list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint160List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint160list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint160List.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint160List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint160list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint160List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint160list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint160list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint160List.prototype[Symbol.dispose] = CompactFheUint160List.prototype.free;

export class CompactFheUint16List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint16List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint16ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint16ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint16list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint16List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint16list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint16List.__wrap(ret[0]);
    }
    /**
     * @param {Uint16Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint16List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray16ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint16list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint16List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint16list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint16list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint16List.prototype[Symbol.dispose] = CompactFheUint16List.prototype.free;

export class CompactFheUint2 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint2.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint2Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint2Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint2_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint2}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint2_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint2}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint2_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint2.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint2}
     */
    expand() {
        const ret = wasm.compactfheuint2_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint2}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint2_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint2.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint2_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint2_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint2.prototype[Symbol.dispose] = CompactFheUint2.prototype.free;

export class CompactFheUint256 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint256.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint256Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint256Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint256_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint256}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint256_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint256}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint256_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint256.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint256}
     */
    expand() {
        const ret = wasm.compactfheuint256_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint256}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint256_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint256.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint256_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint256_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint256.prototype[Symbol.dispose] = CompactFheUint256.prototype.free;

export class CompactFheUint256List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint256List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint256ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint256ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint256list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint256List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint256list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint256List.__wrap(ret[0]);
    }
    /**
     * @param {any[]} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint256List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArrayJsValueToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint256list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint256List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint256list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint256list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint256List.prototype[Symbol.dispose] = CompactFheUint256List.prototype.free;

export class CompactFheUint2List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint2List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint2ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint2ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint2list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint2List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint2list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint2List.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint2List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint2list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint2List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint2list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint2list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint2List.prototype[Symbol.dispose] = CompactFheUint2List.prototype.free;

export class CompactFheUint32 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint32.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint32_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint32}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint32_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint32}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint32_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint32.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint32}
     */
    expand() {
        const ret = wasm.compactfheuint32_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint32}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint32_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint32.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint32_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint32_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint32.prototype[Symbol.dispose] = CompactFheUint32.prototype.free;

export class CompactFheUint32List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint32List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint32ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint32ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint32list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint32List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint32list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint32List.__wrap(ret[0]);
    }
    /**
     * @param {Uint32Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint32List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray32ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint32list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint32List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint32list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint32list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint32List.prototype[Symbol.dispose] = CompactFheUint32List.prototype.free;

export class CompactFheUint4 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint4.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint4Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint4Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint4_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint4}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint4_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint4}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint4_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint4.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint4}
     */
    expand() {
        const ret = wasm.compactfheuint4_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint4}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint4_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint4.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint4_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint4_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint4.prototype[Symbol.dispose] = CompactFheUint4.prototype.free;

export class CompactFheUint4List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint4List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint4ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint4ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint4list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint4List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint4list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint4List.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint4List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint4list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint4List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint4list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint4list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint4List.prototype[Symbol.dispose] = CompactFheUint4List.prototype.free;

export class CompactFheUint6 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint6.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint6Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint6Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint6_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint6}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint6_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint6}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint6_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint6.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint6}
     */
    expand() {
        const ret = wasm.compactfheuint6_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint6}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint6_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint6.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint6_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint6_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint6.prototype[Symbol.dispose] = CompactFheUint6.prototype.free;

export class CompactFheUint64 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint64.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint64_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint64}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint64_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint64}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint64_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint64.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint64}
     */
    expand() {
        const ret = wasm.compactfheuint64_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint64}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint64_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint64_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint64_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint64.prototype[Symbol.dispose] = CompactFheUint64.prototype.free;

export class CompactFheUint64List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint64List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint64ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint64ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint64list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint64List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint64list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint64List.__wrap(ret[0]);
    }
    /**
     * @param {BigUint64Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint64List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray64ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint64list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint64List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint64list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint64list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint64List.prototype[Symbol.dispose] = CompactFheUint64List.prototype.free;

export class CompactFheUint6List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint6List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint6ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint6ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint6list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint6List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint6list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint6List.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint6List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint6list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint6List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint6list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint6list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint6List.prototype[Symbol.dispose] = CompactFheUint6List.prototype.free;

export class CompactFheUint8 {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint8.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint8Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint8_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint8}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint8_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} client_key
     * @returns {CompactFheUint8}
     */
    static encrypt_with_compact_public_key(value, client_key) {
        _assertClass(client_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint8_encrypt_with_compact_public_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint8.__wrap(ret[0]);
    }
    /**
     * @returns {FheUint8}
     */
    expand() {
        const ret = wasm.compactfheuint8_expand(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompactFheUint8}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint8_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint8.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compactfheuint8_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint8_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint8.prototype[Symbol.dispose] = CompactFheUint8.prototype.free;

export class CompactFheUint8List {
    static __wrap(ptr) {
        const obj = Object.create(CompactFheUint8List.prototype);
        obj.__wbg_ptr = ptr;
        CompactFheUint8ListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompactFheUint8ListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compactfheuint8list_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompactFheUint8List}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compactfheuint8list_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint8List.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} values
     * @param {TfheCompactPublicKey} public_key
     * @returns {CompactFheUint8List}
     */
    static encrypt_with_compact_public_key(values, public_key) {
        const ptr0 = passArray8ToWasm0(values, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(public_key, TfheCompactPublicKey);
        const ret = wasm.compactfheuint8list_encrypt_with_compact_public_key(ptr0, len0, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompactFheUint8List.__wrap(ret[0]);
    }
    /**
     * @returns {any[]}
     */
    expand() {
        const ret = wasm.compactfheuint8list_expand(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compactfheuint8list_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompactFheUint8List.prototype[Symbol.dispose] = CompactFheUint8List.prototype.free;

export class CompressedFheBool {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheBool.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheBoolFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheBoolFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfhebool_free(ptr, 0);
    }
    /**
     * @returns {FheBool}
     */
    decompress() {
        const ret = wasm.compressedfhebool_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheBool}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfhebool_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheBool.__wrap(ret[0]);
    }
    /**
     * @param {boolean} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheBool}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfhebool_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheBool.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheBool}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfhebool_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheBool.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfhebool_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfhebool_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheBool.prototype[Symbol.dispose] = CompressedFheBool.prototype.free;

export class CompressedFheInt10 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt10.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt10Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt10Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint10_free(ptr, 0);
    }
    /**
     * @returns {FheInt10}
     */
    decompress() {
        const ret = wasm.compressedfheint10_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt10}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint10_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt10}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint10_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt10}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint10_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt10.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint10_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint10_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt10.prototype[Symbol.dispose] = CompressedFheInt10.prototype.free;

export class CompressedFheInt12 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt12.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt12Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt12Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint12_free(ptr, 0);
    }
    /**
     * @returns {FheInt12}
     */
    decompress() {
        const ret = wasm.compressedfheint12_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt12}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint12_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt12}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint12_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt12}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint12_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt12.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint12_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint12_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt12.prototype[Symbol.dispose] = CompressedFheInt12.prototype.free;

export class CompressedFheInt128 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt128.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt128Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt128Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint128_free(ptr, 0);
    }
    /**
     * @returns {FheInt128}
     */
    decompress() {
        const ret = wasm.compressedfheint128_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt128}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint128_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt128}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint128_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt128}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint128_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt128.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint128_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint128_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt128.prototype[Symbol.dispose] = CompressedFheInt128.prototype.free;

export class CompressedFheInt14 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt14.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt14Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt14Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint14_free(ptr, 0);
    }
    /**
     * @returns {FheInt14}
     */
    decompress() {
        const ret = wasm.compressedfheint14_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt14}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint14_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt14}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint14_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt14}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint14_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt14.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint14_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint14_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt14.prototype[Symbol.dispose] = CompressedFheInt14.prototype.free;

export class CompressedFheInt16 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt16.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt16Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt16Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint16_free(ptr, 0);
    }
    /**
     * @returns {FheInt16}
     */
    decompress() {
        const ret = wasm.compressedfheint16_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt16}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint16_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt16}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint16_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt16}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint16_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt16.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint16_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint16_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt16.prototype[Symbol.dispose] = CompressedFheInt16.prototype.free;

export class CompressedFheInt160 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt160.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt160Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt160Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint160_free(ptr, 0);
    }
    /**
     * @returns {FheInt160}
     */
    decompress() {
        const ret = wasm.compressedfheint160_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt160}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint160_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt160}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint160_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt160}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint160_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt160.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint160_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint160_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt160.prototype[Symbol.dispose] = CompressedFheInt160.prototype.free;

export class CompressedFheInt2 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt2.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt2Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt2Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint2_free(ptr, 0);
    }
    /**
     * @returns {FheInt2}
     */
    decompress() {
        const ret = wasm.compressedfheint2_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt2}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint2_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt2}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint2_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt2}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint2_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt2.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint2_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint2_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt2.prototype[Symbol.dispose] = CompressedFheInt2.prototype.free;

export class CompressedFheInt256 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt256.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt256Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt256Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint256_free(ptr, 0);
    }
    /**
     * @returns {FheInt256}
     */
    decompress() {
        const ret = wasm.compressedfheint256_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt256}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint256_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt256}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint256_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt256}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint256_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt256.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint256_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint256_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt256.prototype[Symbol.dispose] = CompressedFheInt256.prototype.free;

export class CompressedFheInt32 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt32.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint32_free(ptr, 0);
    }
    /**
     * @returns {FheInt32}
     */
    decompress() {
        const ret = wasm.compressedfheint32_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt32}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint32_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt32}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint32_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt32}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint32_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt32.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint32_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint32_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt32.prototype[Symbol.dispose] = CompressedFheInt32.prototype.free;

export class CompressedFheInt4 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt4.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt4Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt4Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint4_free(ptr, 0);
    }
    /**
     * @returns {FheInt4}
     */
    decompress() {
        const ret = wasm.compressedfheint4_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt4}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint4_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt4}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint4_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt4}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint4_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt4.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint4_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint4_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt4.prototype[Symbol.dispose] = CompressedFheInt4.prototype.free;

export class CompressedFheInt6 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt6.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt6Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt6Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint6_free(ptr, 0);
    }
    /**
     * @returns {FheInt6}
     */
    decompress() {
        const ret = wasm.compressedfheint6_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt6}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint6_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt6}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint6_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt6}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint6_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt6.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint6_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint6_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt6.prototype[Symbol.dispose] = CompressedFheInt6.prototype.free;

export class CompressedFheInt64 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt64.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint64_free(ptr, 0);
    }
    /**
     * @returns {FheInt64}
     */
    decompress() {
        const ret = wasm.compressedfheint64_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt64}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint64_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt64}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint64_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt64}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint64_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint64_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint64_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt64.prototype[Symbol.dispose] = CompressedFheInt64.prototype.free;

export class CompressedFheInt8 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheInt8.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheInt8Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheInt8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheint8_free(ptr, 0);
    }
    /**
     * @returns {FheInt8}
     */
    decompress() {
        const ret = wasm.compressedfheint8_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheInt8}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint8_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheInt8}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheint8_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheInt8}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheint8_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheInt8.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheint8_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheint8_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheInt8.prototype[Symbol.dispose] = CompressedFheInt8.prototype.free;

export class CompressedFheUint10 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint10.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint10Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint10Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint10_free(ptr, 0);
    }
    /**
     * @returns {FheUint10}
     */
    decompress() {
        const ret = wasm.compressedfheuint10_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint10}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint10_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint10}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint10_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint10}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint10_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint10.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint10_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint10_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint10.prototype[Symbol.dispose] = CompressedFheUint10.prototype.free;

export class CompressedFheUint12 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint12.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint12Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint12Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint12_free(ptr, 0);
    }
    /**
     * @returns {FheUint12}
     */
    decompress() {
        const ret = wasm.compressedfheuint12_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint12}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint12_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint12}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint12_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint12}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint12_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint12.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint12_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint12_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint12.prototype[Symbol.dispose] = CompressedFheUint12.prototype.free;

export class CompressedFheUint128 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint128.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint128Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint128Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint128_free(ptr, 0);
    }
    /**
     * @returns {FheUint128}
     */
    decompress() {
        const ret = wasm.compressedfheuint128_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint128}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint128_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint128}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint128_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint128}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint128_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint128.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint128_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint128_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint128.prototype[Symbol.dispose] = CompressedFheUint128.prototype.free;

export class CompressedFheUint14 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint14.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint14Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint14Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint14_free(ptr, 0);
    }
    /**
     * @returns {FheUint14}
     */
    decompress() {
        const ret = wasm.compressedfheuint14_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint14}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint14_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint14}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint14_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint14}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint14_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint14.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint14_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint14_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint14.prototype[Symbol.dispose] = CompressedFheUint14.prototype.free;

export class CompressedFheUint16 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint16.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint16Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint16Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint16_free(ptr, 0);
    }
    /**
     * @returns {FheUint16}
     */
    decompress() {
        const ret = wasm.compressedfheuint16_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint16}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint16_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint16}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint16_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint16}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint16_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint16.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint16_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint16_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint16.prototype[Symbol.dispose] = CompressedFheUint16.prototype.free;

export class CompressedFheUint160 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint160.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint160Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint160Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint160_free(ptr, 0);
    }
    /**
     * @returns {FheUint160}
     */
    decompress() {
        const ret = wasm.compressedfheuint160_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint160}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint160_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint160}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint160_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint160}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint160_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint160.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint160_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint160_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint160.prototype[Symbol.dispose] = CompressedFheUint160.prototype.free;

export class CompressedFheUint2 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint2.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint2Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint2Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint2_free(ptr, 0);
    }
    /**
     * @returns {FheUint2}
     */
    decompress() {
        const ret = wasm.compressedfheuint2_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint2}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint2_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint2}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint2_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint2}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint2_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint2.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint2_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint2_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint2.prototype[Symbol.dispose] = CompressedFheUint2.prototype.free;

export class CompressedFheUint256 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint256.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint256Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint256Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint256_free(ptr, 0);
    }
    /**
     * @returns {FheUint256}
     */
    decompress() {
        const ret = wasm.compressedfheuint256_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint256}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint256_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint256}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint256_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint256}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint256_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint256.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint256_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint256_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint256.prototype[Symbol.dispose] = CompressedFheUint256.prototype.free;

export class CompressedFheUint32 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint32.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint32_free(ptr, 0);
    }
    /**
     * @returns {FheUint32}
     */
    decompress() {
        const ret = wasm.compressedfheuint32_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint32}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint32_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint32}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint32_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint32}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint32_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint32.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint32_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint32_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint32.prototype[Symbol.dispose] = CompressedFheUint32.prototype.free;

export class CompressedFheUint4 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint4.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint4Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint4Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint4_free(ptr, 0);
    }
    /**
     * @returns {FheUint4}
     */
    decompress() {
        const ret = wasm.compressedfheuint4_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint4}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint4_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint4}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint4_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint4}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint4_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint4.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint4_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint4_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint4.prototype[Symbol.dispose] = CompressedFheUint4.prototype.free;

export class CompressedFheUint6 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint6.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint6Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint6Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint6_free(ptr, 0);
    }
    /**
     * @returns {FheUint6}
     */
    decompress() {
        const ret = wasm.compressedfheuint6_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint6}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint6_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint6}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint6_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint6}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint6_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint6.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint6_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint6_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint6.prototype[Symbol.dispose] = CompressedFheUint6.prototype.free;

export class CompressedFheUint64 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint64.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint64_free(ptr, 0);
    }
    /**
     * @returns {FheUint64}
     */
    decompress() {
        const ret = wasm.compressedfheuint64_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint64}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint64_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint64}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint64_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint64}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint64_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint64_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint64_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint64.prototype[Symbol.dispose] = CompressedFheUint64.prototype.free;

export class CompressedFheUint8 {
    static __wrap(ptr) {
        const obj = Object.create(CompressedFheUint8.prototype);
        obj.__wbg_ptr = ptr;
        CompressedFheUint8Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CompressedFheUint8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_compressedfheuint8_free(ptr, 0);
    }
    /**
     * @returns {FheUint8}
     */
    decompress() {
        const ret = wasm.compressedfheuint8_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {CompressedFheUint8}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint8_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {CompressedFheUint8}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.compressedfheuint8_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {CompressedFheUint8}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.compressedfheuint8_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CompressedFheUint8.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.compressedfheuint8_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.compressedfheuint8_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) CompressedFheUint8.prototype[Symbol.dispose] = CompressedFheUint8.prototype.free;

export class FheBool {
    static __wrap(ptr) {
        const obj = Object.create(FheBool.prototype);
        obj.__wbg_ptr = ptr;
        FheBoolFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheBoolFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fhebool_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {boolean}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fhebool_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheBool}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fhebool_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {boolean} value
     * @param {TfheClientKey} client_key
     * @returns {FheBool}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fhebool_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {boolean} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheBool}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fhebool_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {boolean} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheBool}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fhebool_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {boolean} value
     * @param {TfhePublicKey} public_key
     * @returns {FheBool}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fhebool_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheBool}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fhebool_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheBool.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fhebool_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fhebool_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheBool.prototype[Symbol.dispose] = FheBool.prototype.free;

export class FheInt10 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt10.prototype);
        obj.__wbg_ptr = ptr;
        FheInt10Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt10Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint10_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint10_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt10}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint10_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt10}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint10_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt10}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint10_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt10}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint10_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt10}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint10_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt10}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint10_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt10.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint10_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint10_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt10.prototype[Symbol.dispose] = FheInt10.prototype.free;

export class FheInt12 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt12.prototype);
        obj.__wbg_ptr = ptr;
        FheInt12Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt12Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint12_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint12_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt12}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint12_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt12}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint12_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt12}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint12_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt12}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint12_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt12}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint12_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt12}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint12_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt12.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint12_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint12_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt12.prototype[Symbol.dispose] = FheInt12.prototype.free;

export class FheInt128 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt128.prototype);
        obj.__wbg_ptr = ptr;
        FheInt128Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt128Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint128_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {any}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint128_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt128}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint128_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt128}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint128_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt128}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint128_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt128}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint128_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt128}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint128_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt128}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint128_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt128.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint128_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint128_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt128.prototype[Symbol.dispose] = FheInt128.prototype.free;

export class FheInt14 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt14.prototype);
        obj.__wbg_ptr = ptr;
        FheInt14Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt14Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint14_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint14_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt14}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint14_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt14}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint14_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt14}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint14_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt14}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint14_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt14}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint14_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt14}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint14_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt14.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint14_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint14_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt14.prototype[Symbol.dispose] = FheInt14.prototype.free;

export class FheInt16 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt16.prototype);
        obj.__wbg_ptr = ptr;
        FheInt16Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt16Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint16_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint16_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt16}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint16_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt16}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint16_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt16}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint16_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt16}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint16_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt16}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint16_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt16}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint16_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt16.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint16_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint16_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt16.prototype[Symbol.dispose] = FheInt16.prototype.free;

export class FheInt160 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt160.prototype);
        obj.__wbg_ptr = ptr;
        FheInt160Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt160Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint160_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {any}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint160_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt160}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint160_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt160}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint160_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt160}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint160_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt160}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint160_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt160}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint160_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt160}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint160_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt160.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint160_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint160_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt160.prototype[Symbol.dispose] = FheInt160.prototype.free;

export class FheInt2 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt2.prototype);
        obj.__wbg_ptr = ptr;
        FheInt2Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt2Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint2_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint2_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt2}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint2_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt2}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint2_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt2}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint2_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt2}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint2_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt2}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint2_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt2}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint2_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt2.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint2_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint2_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt2.prototype[Symbol.dispose] = FheInt2.prototype.free;

export class FheInt256 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt256.prototype);
        obj.__wbg_ptr = ptr;
        FheInt256Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt256Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint256_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {any}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint256_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt256}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint256_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt256}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint256_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt256}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint256_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt256}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint256_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt256}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint256_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt256}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint256_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt256.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint256_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint256_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt256.prototype[Symbol.dispose] = FheInt256.prototype.free;

export class FheInt32 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt32.prototype);
        obj.__wbg_ptr = ptr;
        FheInt32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint32_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint32_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt32}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint32_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt32}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint32_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt32}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint32_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt32}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint32_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt32}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint32_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt32}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint32_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt32.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint32_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint32_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt32.prototype[Symbol.dispose] = FheInt32.prototype.free;

export class FheInt4 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt4.prototype);
        obj.__wbg_ptr = ptr;
        FheInt4Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt4Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint4_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint4_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt4}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint4_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt4}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint4_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt4}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint4_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt4}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint4_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt4}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint4_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt4}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint4_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt4.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint4_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint4_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt4.prototype[Symbol.dispose] = FheInt4.prototype.free;

export class FheInt6 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt6.prototype);
        obj.__wbg_ptr = ptr;
        FheInt6Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt6Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint6_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint6_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt6}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint6_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt6}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint6_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt6}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint6_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt6}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint6_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt6}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint6_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt6}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint6_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt6.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint6_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint6_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt6.prototype[Symbol.dispose] = FheInt6.prototype.free;

export class FheInt64 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt64.prototype);
        obj.__wbg_ptr = ptr;
        FheInt64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint64_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {bigint}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint64_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt64}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint64_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt64}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint64_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt64}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint64_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt64}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint64_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt64}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint64_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt64}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint64_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint64_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint64_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt64.prototype[Symbol.dispose] = FheInt64.prototype.free;

export class FheInt8 {
    static __wrap(ptr) {
        const obj = Object.create(FheInt8.prototype);
        obj.__wbg_ptr = ptr;
        FheInt8Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheInt8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheint8_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint8_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheInt8}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint8_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheInt8}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheint8_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheInt8}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheint8_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheInt8}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheint8_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheInt8}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheint8_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheInt8}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheint8_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheInt8.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheint8_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheint8_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheInt8.prototype[Symbol.dispose] = FheInt8.prototype.free;

export class FheUint10 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint10.prototype);
        obj.__wbg_ptr = ptr;
        FheUint10Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint10Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint10_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint10_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint10}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint10_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint10}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint10_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint10}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint10_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint10}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint10_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint10}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint10_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint10}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint10_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint10.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint10_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint10_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint10.prototype[Symbol.dispose] = FheUint10.prototype.free;

export class FheUint12 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint12.prototype);
        obj.__wbg_ptr = ptr;
        FheUint12Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint12Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint12_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint12_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint12}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint12_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint12}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint12_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint12}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint12_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint12}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint12_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint12}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint12_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint12}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint12_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint12.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint12_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint12_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint12.prototype[Symbol.dispose] = FheUint12.prototype.free;

export class FheUint128 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint128.prototype);
        obj.__wbg_ptr = ptr;
        FheUint128Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint128Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint128_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {any}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint128_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint128}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint128_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint128}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint128_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint128}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint128_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint128}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint128_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint128}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint128_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint128}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint128_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint128.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint128_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint128_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint128.prototype[Symbol.dispose] = FheUint128.prototype.free;

export class FheUint14 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint14.prototype);
        obj.__wbg_ptr = ptr;
        FheUint14Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint14Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint14_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint14_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint14}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint14_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint14}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint14_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint14}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint14_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint14}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint14_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint14}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint14_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint14}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint14_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint14.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint14_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint14_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint14.prototype[Symbol.dispose] = FheUint14.prototype.free;

export class FheUint16 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint16.prototype);
        obj.__wbg_ptr = ptr;
        FheUint16Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint16Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint16_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint16_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint16}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint16_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint16}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint16_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint16}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint16_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint16}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint16_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint16}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint16_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint16}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint16_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint16.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint16_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint16_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint16.prototype[Symbol.dispose] = FheUint16.prototype.free;

export class FheUint160 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint160.prototype);
        obj.__wbg_ptr = ptr;
        FheUint160Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint160Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint160_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {any}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint160_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint160}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint160_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint160}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint160_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint160}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint160_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint160}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint160_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint160}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint160_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint160}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint160_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint160.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint160_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint160_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint160.prototype[Symbol.dispose] = FheUint160.prototype.free;

export class FheUint2 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint2.prototype);
        obj.__wbg_ptr = ptr;
        FheUint2Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint2Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint2_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint2_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint2}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint2_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint2}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint2_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint2}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint2_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint2}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint2_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint2}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint2_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint2}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint2_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint2.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint2_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint2_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint2.prototype[Symbol.dispose] = FheUint2.prototype.free;

export class FheUint256 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint256.prototype);
        obj.__wbg_ptr = ptr;
        FheUint256Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint256Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint256_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {any}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint256_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint256}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint256_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint256}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint256_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint256}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint256_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint256}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint256_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {any} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint256}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint256_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint256}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint256_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint256.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint256_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint256_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint256.prototype[Symbol.dispose] = FheUint256.prototype.free;

export class FheUint32 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint32.prototype);
        obj.__wbg_ptr = ptr;
        FheUint32Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint32Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint32_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint32_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint32}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint32_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint32}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint32_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint32}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint32_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint32}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint32_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint32}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint32_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint32}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint32_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint32.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint32_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint32_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint32.prototype[Symbol.dispose] = FheUint32.prototype.free;

export class FheUint4 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint4.prototype);
        obj.__wbg_ptr = ptr;
        FheUint4Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint4Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint4_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint4_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint4}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint4_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint4}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint4_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint4}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint4_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint4}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint4_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint4}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint4_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint4}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint4_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint4.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint4_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint4_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint4.prototype[Symbol.dispose] = FheUint4.prototype.free;

export class FheUint6 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint6.prototype);
        obj.__wbg_ptr = ptr;
        FheUint6Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint6Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint6_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint6_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint6}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint6_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint6}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint6_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint6}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint6_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint6}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint6_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint6}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint6_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint6}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint6_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint6.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint6_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint6_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint6.prototype[Symbol.dispose] = FheUint6.prototype.free;

export class FheUint64 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint64.prototype);
        obj.__wbg_ptr = ptr;
        FheUint64Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint64Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint64_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {bigint}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint64_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return BigInt.asUintN(64, ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint64}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint64_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint64}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint64_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint64}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint64_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint64}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint64_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint64}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint64_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint64}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint64_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint64.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint64_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint64_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint64.prototype[Symbol.dispose] = FheUint64.prototype.free;

export class FheUint8 {
    static __wrap(ptr) {
        const obj = Object.create(FheUint8.prototype);
        obj.__wbg_ptr = ptr;
        FheUint8Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FheUint8Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fheuint8_free(ptr, 0);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {number}
     */
    decrypt(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint8_decrypt(this.__wbg_ptr, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {FheUint8}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint8_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheClientKey} client_key
     * @returns {FheUint8}
     */
    static encrypt_with_client_key(value, client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.fheuint8_encrypt_with_client_key(value, client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompactPublicKey} compact_public_key
     * @returns {FheUint8}
     */
    static encrypt_with_compact_public_key(value, compact_public_key) {
        _assertClass(compact_public_key, TfheCompactPublicKey);
        const ret = wasm.fheuint8_encrypt_with_compact_public_key(value, compact_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfheCompressedPublicKey} compressed_public_key
     * @returns {FheUint8}
     */
    static encrypt_with_compressed_public_key(value, compressed_public_key) {
        _assertClass(compressed_public_key, TfheCompressedPublicKey);
        const ret = wasm.fheuint8_encrypt_with_compressed_public_key(value, compressed_public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {number} value
     * @param {TfhePublicKey} public_key
     * @returns {FheUint8}
     */
    static encrypt_with_public_key(value, public_key) {
        _assertClass(public_key, TfhePublicKey);
        const ret = wasm.fheuint8_encrypt_with_public_key(value, public_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @param {bigint} serialized_size_limit
     * @returns {FheUint8}
     */
    static safe_deserialize(buffer, serialized_size_limit) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fheuint8_safe_deserialize(ptr0, len0, serialized_size_limit);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FheUint8.__wrap(ret[0]);
    }
    /**
     * @param {bigint} serialized_size_limit
     * @returns {Uint8Array}
     */
    safe_serialize(serialized_size_limit) {
        const ret = wasm.fheuint8_safe_serialize(this.__wbg_ptr, serialized_size_limit);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.fheuint8_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) FheUint8.prototype[Symbol.dispose] = FheUint8.prototype.free;

export class Shortint {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortint_free(ptr, 0);
    }
    /**
     * @param {ShortintCompressedCiphertext} compressed_ciphertext
     * @returns {ShortintCiphertext}
     */
    static decompress_ciphertext(compressed_ciphertext) {
        _assertClass(compressed_ciphertext, ShortintCompressedCiphertext);
        const ret = wasm.shortint_decompress_ciphertext(compressed_ciphertext.__wbg_ptr);
        return ShortintCiphertext.__wrap(ret);
    }
    /**
     * @param {ShortintClientKey} client_key
     * @param {ShortintCiphertext} ct
     * @returns {bigint}
     */
    static decrypt(client_key, ct) {
        _assertClass(client_key, ShortintClientKey);
        _assertClass(ct, ShortintCiphertext);
        const ret = wasm.shortint_decrypt(client_key.__wbg_ptr, ct.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {ShortintCiphertext}
     */
    static deserialize_ciphertext(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortint_deserialize_ciphertext(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintCiphertext.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {ShortintClientKey}
     */
    static deserialize_client_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortint_deserialize_client_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintClientKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {ShortintCompressedCiphertext}
     */
    static deserialize_compressed_ciphertext(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortint_deserialize_compressed_ciphertext(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintCompressedCiphertext.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {ShortintCompressedPublicKey}
     */
    static deserialize_compressed_public_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortint_deserialize_compressed_public_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintCompressedPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {ShortintCompressedServerKey}
     */
    static deserialize_compressed_server_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortint_deserialize_compressed_server_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintCompressedServerKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {ShortintPublicKey}
     */
    static deserialize_public_key(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortint_deserialize_public_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {ShortintClientKey} client_key
     * @param {bigint} message
     * @returns {ShortintCiphertext}
     */
    static encrypt(client_key, message) {
        _assertClass(client_key, ShortintClientKey);
        const ret = wasm.shortint_encrypt(client_key.__wbg_ptr, message);
        return ShortintCiphertext.__wrap(ret);
    }
    /**
     * @param {ShortintClientKey} client_key
     * @param {bigint} message
     * @returns {ShortintCompressedCiphertext}
     */
    static encrypt_compressed(client_key, message) {
        _assertClass(client_key, ShortintClientKey);
        const ret = wasm.shortint_encrypt_compressed(client_key.__wbg_ptr, message);
        return ShortintCompressedCiphertext.__wrap(ret);
    }
    /**
     * @param {ShortintCompressedPublicKey} public_key
     * @param {bigint} message
     * @returns {ShortintCiphertext}
     */
    static encrypt_with_compressed_public_key(public_key, message) {
        _assertClass(public_key, ShortintCompressedPublicKey);
        const ret = wasm.shortint_encrypt_with_compressed_public_key(public_key.__wbg_ptr, message);
        return ShortintCiphertext.__wrap(ret);
    }
    /**
     * @param {ShortintPublicKey} public_key
     * @param {bigint} message
     * @returns {ShortintCiphertext}
     */
    static encrypt_with_public_key(public_key, message) {
        _assertClass(public_key, ShortintPublicKey);
        const ret = wasm.shortint_encrypt_with_public_key(public_key.__wbg_ptr, message);
        return ShortintCiphertext.__wrap(ret);
    }
    /**
     * @param {number} message_bits
     * @param {number} carry_bits
     * @returns {ShortintParameters}
     */
    static get_parameters(message_bits, carry_bits) {
        const ret = wasm.shortint_get_parameters(message_bits, carry_bits);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintParameters.__wrap(ret[0]);
    }
    /**
     * @param {number} message_bits
     * @param {number} carry_bits
     * @returns {ShortintParameters}
     */
    static get_parameters_small(message_bits, carry_bits) {
        const ret = wasm.shortint_get_parameters_small(message_bits, carry_bits);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ShortintParameters.__wrap(ret[0]);
    }
    /**
     * @param {ShortintParameters} parameters
     * @returns {ShortintClientKey}
     */
    static new_client_key(parameters) {
        _assertClass(parameters, ShortintParameters);
        const ret = wasm.shortint_new_client_key(parameters.__wbg_ptr);
        return ShortintClientKey.__wrap(ret);
    }
    /**
     * @param {bigint} seed_high_bytes
     * @param {bigint} seed_low_bytes
     * @param {ShortintParameters} parameters
     * @returns {ShortintClientKey}
     */
    static new_client_key_from_seed_and_parameters(seed_high_bytes, seed_low_bytes, parameters) {
        _assertClass(parameters, ShortintParameters);
        const ret = wasm.shortint_new_client_key_from_seed_and_parameters(seed_high_bytes, seed_low_bytes, parameters.__wbg_ptr);
        return ShortintClientKey.__wrap(ret);
    }
    /**
     * @param {ShortintClientKey} client_key
     * @returns {ShortintCompressedPublicKey}
     */
    static new_compressed_public_key(client_key) {
        _assertClass(client_key, ShortintClientKey);
        const ret = wasm.shortint_new_compressed_public_key(client_key.__wbg_ptr);
        return ShortintCompressedPublicKey.__wrap(ret);
    }
    /**
     * @param {ShortintClientKey} client_key
     * @returns {ShortintCompressedServerKey}
     */
    static new_compressed_server_key(client_key) {
        _assertClass(client_key, ShortintClientKey);
        const ret = wasm.shortint_new_compressed_server_key(client_key.__wbg_ptr);
        return ShortintCompressedServerKey.__wrap(ret);
    }
    /**
     * @param {number} lwe_dimension
     * @param {number} glwe_dimension
     * @param {number} polynomial_size
     * @param {number} lwe_modular_std_dev
     * @param {number} glwe_modular_std_dev
     * @param {number} pbs_base_log
     * @param {number} pbs_level
     * @param {number} ks_base_log
     * @param {number} ks_level
     * @param {number} message_modulus
     * @param {number} carry_modulus
     * @param {number} modulus_power_of_2_exponent
     * @param {ShortintEncryptionKeyChoice} encryption_key_choice
     * @returns {ShortintParameters}
     */
    static new_parameters(lwe_dimension, glwe_dimension, polynomial_size, lwe_modular_std_dev, glwe_modular_std_dev, pbs_base_log, pbs_level, ks_base_log, ks_level, message_modulus, carry_modulus, modulus_power_of_2_exponent, encryption_key_choice) {
        const ret = wasm.shortint_new_parameters(lwe_dimension, glwe_dimension, polynomial_size, lwe_modular_std_dev, glwe_modular_std_dev, pbs_base_log, pbs_level, ks_base_log, ks_level, message_modulus, carry_modulus, modulus_power_of_2_exponent, encryption_key_choice);
        return ShortintParameters.__wrap(ret);
    }
    /**
     * @param {ShortintClientKey} client_key
     * @returns {ShortintPublicKey}
     */
    static new_public_key(client_key) {
        _assertClass(client_key, ShortintClientKey);
        const ret = wasm.shortint_new_public_key(client_key.__wbg_ptr);
        return ShortintPublicKey.__wrap(ret);
    }
    /**
     * @param {ShortintCiphertext} ciphertext
     * @returns {Uint8Array}
     */
    static serialize_ciphertext(ciphertext) {
        _assertClass(ciphertext, ShortintCiphertext);
        const ret = wasm.shortint_serialize_ciphertext(ciphertext.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {ShortintClientKey} client_key
     * @returns {Uint8Array}
     */
    static serialize_client_key(client_key) {
        _assertClass(client_key, ShortintClientKey);
        const ret = wasm.shortint_serialize_client_key(client_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {ShortintCompressedCiphertext} ciphertext
     * @returns {Uint8Array}
     */
    static serialize_compressed_ciphertext(ciphertext) {
        _assertClass(ciphertext, ShortintCompressedCiphertext);
        const ret = wasm.shortint_serialize_compressed_ciphertext(ciphertext.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {ShortintCompressedPublicKey} public_key
     * @returns {Uint8Array}
     */
    static serialize_compressed_public_key(public_key) {
        _assertClass(public_key, ShortintCompressedPublicKey);
        const ret = wasm.shortint_serialize_compressed_public_key(public_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {ShortintCompressedServerKey} server_key
     * @returns {Uint8Array}
     */
    static serialize_compressed_server_key(server_key) {
        _assertClass(server_key, ShortintCompressedServerKey);
        const ret = wasm.shortint_serialize_compressed_server_key(server_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {ShortintPublicKey} public_key
     * @returns {Uint8Array}
     */
    static serialize_public_key(public_key) {
        _assertClass(public_key, ShortintPublicKey);
        const ret = wasm.shortint_serialize_public_key(public_key.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Shortint.prototype[Symbol.dispose] = Shortint.prototype.free;

export class ShortintCiphertext {
    static __wrap(ptr) {
        const obj = Object.create(ShortintCiphertext.prototype);
        obj.__wbg_ptr = ptr;
        ShortintCiphertextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintCiphertextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintciphertext_free(ptr, 0);
    }
}
if (Symbol.dispose) ShortintCiphertext.prototype[Symbol.dispose] = ShortintCiphertext.prototype.free;

export class ShortintClientKey {
    static __wrap(ptr) {
        const obj = Object.create(ShortintClientKey.prototype);
        obj.__wbg_ptr = ptr;
        ShortintClientKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintClientKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintclientkey_free(ptr, 0);
    }
}
if (Symbol.dispose) ShortintClientKey.prototype[Symbol.dispose] = ShortintClientKey.prototype.free;

export class ShortintCompressedCiphertext {
    static __wrap(ptr) {
        const obj = Object.create(ShortintCompressedCiphertext.prototype);
        obj.__wbg_ptr = ptr;
        ShortintCompressedCiphertextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintCompressedCiphertextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintcompressedciphertext_free(ptr, 0);
    }
}
if (Symbol.dispose) ShortintCompressedCiphertext.prototype[Symbol.dispose] = ShortintCompressedCiphertext.prototype.free;

export class ShortintCompressedPublicKey {
    static __wrap(ptr) {
        const obj = Object.create(ShortintCompressedPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        ShortintCompressedPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintCompressedPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintcompressedpublickey_free(ptr, 0);
    }
}
if (Symbol.dispose) ShortintCompressedPublicKey.prototype[Symbol.dispose] = ShortintCompressedPublicKey.prototype.free;

export class ShortintCompressedServerKey {
    static __wrap(ptr) {
        const obj = Object.create(ShortintCompressedServerKey.prototype);
        obj.__wbg_ptr = ptr;
        ShortintCompressedServerKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintCompressedServerKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintcompressedserverkey_free(ptr, 0);
    }
}
if (Symbol.dispose) ShortintCompressedServerKey.prototype[Symbol.dispose] = ShortintCompressedServerKey.prototype.free;

/**
 * @enum {0 | 1}
 */
export const ShortintEncryptionKeyChoice = Object.freeze({
    Big: 0, "0": "Big",
    Small: 1, "1": "Small",
});

export class ShortintParameters {
    static __wrap(ptr) {
        const obj = Object.create(ShortintParameters.prototype);
        obj.__wbg_ptr = ptr;
        ShortintParametersFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintParametersFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintparameters_free(ptr, 0);
    }
    /**
     * @param {ShortintParametersName} name
     */
    constructor(name) {
        const ret = wasm.shortintparameters_new(name);
        this.__wbg_ptr = ret;
        ShortintParametersFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ShortintParameters.prototype[Symbol.dispose] = ShortintParameters.prototype.free;

/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63 | 64 | 65 | 66 | 67 | 68 | 69 | 70 | 71 | 72 | 73 | 74 | 75 | 76 | 77 | 78 | 79 | 80 | 81 | 82 | 83 | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94 | 95 | 96 | 97 | 98 | 99 | 100 | 101 | 102 | 103 | 104 | 105 | 106 | 107 | 108 | 109 | 110 | 111 | 112 | 113 | 114 | 115 | 116 | 117 | 118 | 119 | 120 | 121 | 122 | 123 | 124 | 125 | 126 | 127 | 128 | 129 | 130 | 131 | 132 | 133 | 134}
 */
export const ShortintParametersName = Object.freeze({
    PARAM_MESSAGE_1_CARRY_0_KS_PBS: 0, "0": "PARAM_MESSAGE_1_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_1_KS_PBS: 1, "1": "PARAM_MESSAGE_1_CARRY_1_KS_PBS",
    PARAM_MESSAGE_2_CARRY_0_KS_PBS: 2, "2": "PARAM_MESSAGE_2_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_2_KS_PBS: 3, "3": "PARAM_MESSAGE_1_CARRY_2_KS_PBS",
    PARAM_MESSAGE_2_CARRY_1_KS_PBS: 4, "4": "PARAM_MESSAGE_2_CARRY_1_KS_PBS",
    PARAM_MESSAGE_3_CARRY_0_KS_PBS: 5, "5": "PARAM_MESSAGE_3_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_3_KS_PBS: 6, "6": "PARAM_MESSAGE_1_CARRY_3_KS_PBS",
    PARAM_MESSAGE_2_CARRY_2_KS_PBS: 7, "7": "PARAM_MESSAGE_2_CARRY_2_KS_PBS",
    PARAM_MESSAGE_3_CARRY_1_KS_PBS: 8, "8": "PARAM_MESSAGE_3_CARRY_1_KS_PBS",
    PARAM_MESSAGE_4_CARRY_0_KS_PBS: 9, "9": "PARAM_MESSAGE_4_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_4_KS_PBS: 10, "10": "PARAM_MESSAGE_1_CARRY_4_KS_PBS",
    PARAM_MESSAGE_2_CARRY_3_KS_PBS: 11, "11": "PARAM_MESSAGE_2_CARRY_3_KS_PBS",
    PARAM_MESSAGE_3_CARRY_2_KS_PBS: 12, "12": "PARAM_MESSAGE_3_CARRY_2_KS_PBS",
    PARAM_MESSAGE_4_CARRY_1_KS_PBS: 13, "13": "PARAM_MESSAGE_4_CARRY_1_KS_PBS",
    PARAM_MESSAGE_5_CARRY_0_KS_PBS: 14, "14": "PARAM_MESSAGE_5_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_5_KS_PBS: 15, "15": "PARAM_MESSAGE_1_CARRY_5_KS_PBS",
    PARAM_MESSAGE_2_CARRY_4_KS_PBS: 16, "16": "PARAM_MESSAGE_2_CARRY_4_KS_PBS",
    PARAM_MESSAGE_3_CARRY_3_KS_PBS: 17, "17": "PARAM_MESSAGE_3_CARRY_3_KS_PBS",
    PARAM_MESSAGE_4_CARRY_2_KS_PBS: 18, "18": "PARAM_MESSAGE_4_CARRY_2_KS_PBS",
    PARAM_MESSAGE_5_CARRY_1_KS_PBS: 19, "19": "PARAM_MESSAGE_5_CARRY_1_KS_PBS",
    PARAM_MESSAGE_6_CARRY_0_KS_PBS: 20, "20": "PARAM_MESSAGE_6_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_6_KS_PBS: 21, "21": "PARAM_MESSAGE_1_CARRY_6_KS_PBS",
    PARAM_MESSAGE_2_CARRY_5_KS_PBS: 22, "22": "PARAM_MESSAGE_2_CARRY_5_KS_PBS",
    PARAM_MESSAGE_3_CARRY_4_KS_PBS: 23, "23": "PARAM_MESSAGE_3_CARRY_4_KS_PBS",
    PARAM_MESSAGE_4_CARRY_3_KS_PBS: 24, "24": "PARAM_MESSAGE_4_CARRY_3_KS_PBS",
    PARAM_MESSAGE_5_CARRY_2_KS_PBS: 25, "25": "PARAM_MESSAGE_5_CARRY_2_KS_PBS",
    PARAM_MESSAGE_6_CARRY_1_KS_PBS: 26, "26": "PARAM_MESSAGE_6_CARRY_1_KS_PBS",
    PARAM_MESSAGE_7_CARRY_0_KS_PBS: 27, "27": "PARAM_MESSAGE_7_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_7_KS_PBS: 28, "28": "PARAM_MESSAGE_1_CARRY_7_KS_PBS",
    PARAM_MESSAGE_2_CARRY_6_KS_PBS: 29, "29": "PARAM_MESSAGE_2_CARRY_6_KS_PBS",
    PARAM_MESSAGE_3_CARRY_5_KS_PBS: 30, "30": "PARAM_MESSAGE_3_CARRY_5_KS_PBS",
    PARAM_MESSAGE_4_CARRY_4_KS_PBS: 31, "31": "PARAM_MESSAGE_4_CARRY_4_KS_PBS",
    PARAM_MESSAGE_5_CARRY_3_KS_PBS: 32, "32": "PARAM_MESSAGE_5_CARRY_3_KS_PBS",
    PARAM_MESSAGE_6_CARRY_2_KS_PBS: 33, "33": "PARAM_MESSAGE_6_CARRY_2_KS_PBS",
    PARAM_MESSAGE_7_CARRY_1_KS_PBS: 34, "34": "PARAM_MESSAGE_7_CARRY_1_KS_PBS",
    PARAM_MESSAGE_8_CARRY_0_KS_PBS: 35, "35": "PARAM_MESSAGE_8_CARRY_0_KS_PBS",
    PARAM_MESSAGE_1_CARRY_1_PBS_KS: 36, "36": "PARAM_MESSAGE_1_CARRY_1_PBS_KS",
    PARAM_MESSAGE_2_CARRY_2_PBS_KS: 37, "37": "PARAM_MESSAGE_2_CARRY_2_PBS_KS",
    PARAM_MESSAGE_3_CARRY_3_PBS_KS: 38, "38": "PARAM_MESSAGE_3_CARRY_3_PBS_KS",
    PARAM_MESSAGE_4_CARRY_4_PBS_KS: 39, "39": "PARAM_MESSAGE_4_CARRY_4_PBS_KS",
    PARAM_MESSAGE_1_CARRY_2_COMPACT_PK_KS_PBS: 40, "40": "PARAM_MESSAGE_1_CARRY_2_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_1_CARRY_3_COMPACT_PK_KS_PBS: 41, "41": "PARAM_MESSAGE_1_CARRY_3_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_1_CARRY_4_COMPACT_PK_KS_PBS: 42, "42": "PARAM_MESSAGE_1_CARRY_4_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_1_CARRY_5_COMPACT_PK_KS_PBS: 43, "43": "PARAM_MESSAGE_1_CARRY_5_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_1_CARRY_6_COMPACT_PK_KS_PBS: 44, "44": "PARAM_MESSAGE_1_CARRY_6_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_1_CARRY_7_COMPACT_PK_KS_PBS: 45, "45": "PARAM_MESSAGE_1_CARRY_7_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_2_CARRY_1_COMPACT_PK_KS_PBS: 46, "46": "PARAM_MESSAGE_2_CARRY_1_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_2_CARRY_2_COMPACT_PK_KS_PBS: 47, "47": "PARAM_MESSAGE_2_CARRY_2_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_2_CARRY_3_COMPACT_PK_KS_PBS: 48, "48": "PARAM_MESSAGE_2_CARRY_3_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_2_CARRY_4_COMPACT_PK_KS_PBS: 49, "49": "PARAM_MESSAGE_2_CARRY_4_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_2_CARRY_5_COMPACT_PK_KS_PBS: 50, "50": "PARAM_MESSAGE_2_CARRY_5_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_2_CARRY_6_COMPACT_PK_KS_PBS: 51, "51": "PARAM_MESSAGE_2_CARRY_6_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_3_CARRY_1_COMPACT_PK_KS_PBS: 52, "52": "PARAM_MESSAGE_3_CARRY_1_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_3_CARRY_2_COMPACT_PK_KS_PBS: 53, "53": "PARAM_MESSAGE_3_CARRY_2_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_3_CARRY_3_COMPACT_PK_KS_PBS: 54, "54": "PARAM_MESSAGE_3_CARRY_3_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_3_CARRY_4_COMPACT_PK_KS_PBS: 55, "55": "PARAM_MESSAGE_3_CARRY_4_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_3_CARRY_5_COMPACT_PK_KS_PBS: 56, "56": "PARAM_MESSAGE_3_CARRY_5_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_4_CARRY_1_COMPACT_PK_KS_PBS: 57, "57": "PARAM_MESSAGE_4_CARRY_1_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_4_CARRY_2_COMPACT_PK_KS_PBS: 58, "58": "PARAM_MESSAGE_4_CARRY_2_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_4_CARRY_3_COMPACT_PK_KS_PBS: 59, "59": "PARAM_MESSAGE_4_CARRY_3_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_4_CARRY_4_COMPACT_PK_KS_PBS: 60, "60": "PARAM_MESSAGE_4_CARRY_4_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_5_CARRY_1_COMPACT_PK_KS_PBS: 61, "61": "PARAM_MESSAGE_5_CARRY_1_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_5_CARRY_2_COMPACT_PK_KS_PBS: 62, "62": "PARAM_MESSAGE_5_CARRY_2_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_5_CARRY_3_COMPACT_PK_KS_PBS: 63, "63": "PARAM_MESSAGE_5_CARRY_3_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_6_CARRY_1_COMPACT_PK_KS_PBS: 64, "64": "PARAM_MESSAGE_6_CARRY_1_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_6_CARRY_2_COMPACT_PK_KS_PBS: 65, "65": "PARAM_MESSAGE_6_CARRY_2_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_7_CARRY_1_COMPACT_PK_KS_PBS: 66, "66": "PARAM_MESSAGE_7_CARRY_1_COMPACT_PK_KS_PBS",
    PARAM_MESSAGE_1_CARRY_1_COMPACT_PK_PBS_KS: 67, "67": "PARAM_MESSAGE_1_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_2_COMPACT_PK_PBS_KS: 68, "68": "PARAM_MESSAGE_1_CARRY_2_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_3_COMPACT_PK_PBS_KS: 69, "69": "PARAM_MESSAGE_1_CARRY_3_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_4_COMPACT_PK_PBS_KS: 70, "70": "PARAM_MESSAGE_1_CARRY_4_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_5_COMPACT_PK_PBS_KS: 71, "71": "PARAM_MESSAGE_1_CARRY_5_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_6_COMPACT_PK_PBS_KS: 72, "72": "PARAM_MESSAGE_1_CARRY_6_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_7_COMPACT_PK_PBS_KS: 73, "73": "PARAM_MESSAGE_1_CARRY_7_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_2_CARRY_1_COMPACT_PK_PBS_KS: 74, "74": "PARAM_MESSAGE_2_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_2_CARRY_2_COMPACT_PK_PBS_KS: 75, "75": "PARAM_MESSAGE_2_CARRY_2_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_2_CARRY_3_COMPACT_PK_PBS_KS: 76, "76": "PARAM_MESSAGE_2_CARRY_3_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_2_CARRY_4_COMPACT_PK_PBS_KS: 77, "77": "PARAM_MESSAGE_2_CARRY_4_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_2_CARRY_5_COMPACT_PK_PBS_KS: 78, "78": "PARAM_MESSAGE_2_CARRY_5_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_2_CARRY_6_COMPACT_PK_PBS_KS: 79, "79": "PARAM_MESSAGE_2_CARRY_6_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_3_CARRY_1_COMPACT_PK_PBS_KS: 80, "80": "PARAM_MESSAGE_3_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_3_CARRY_2_COMPACT_PK_PBS_KS: 81, "81": "PARAM_MESSAGE_3_CARRY_2_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_3_CARRY_3_COMPACT_PK_PBS_KS: 82, "82": "PARAM_MESSAGE_3_CARRY_3_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_3_CARRY_4_COMPACT_PK_PBS_KS: 83, "83": "PARAM_MESSAGE_3_CARRY_4_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_3_CARRY_5_COMPACT_PK_PBS_KS: 84, "84": "PARAM_MESSAGE_3_CARRY_5_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_4_CARRY_1_COMPACT_PK_PBS_KS: 85, "85": "PARAM_MESSAGE_4_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_4_CARRY_2_COMPACT_PK_PBS_KS: 86, "86": "PARAM_MESSAGE_4_CARRY_2_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_4_CARRY_3_COMPACT_PK_PBS_KS: 87, "87": "PARAM_MESSAGE_4_CARRY_3_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_4_CARRY_4_COMPACT_PK_PBS_KS: 88, "88": "PARAM_MESSAGE_4_CARRY_4_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_5_CARRY_1_COMPACT_PK_PBS_KS: 89, "89": "PARAM_MESSAGE_5_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_5_CARRY_2_COMPACT_PK_PBS_KS: 90, "90": "PARAM_MESSAGE_5_CARRY_2_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_5_CARRY_3_COMPACT_PK_PBS_KS: 91, "91": "PARAM_MESSAGE_5_CARRY_3_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_6_CARRY_1_COMPACT_PK_PBS_KS: 92, "92": "PARAM_MESSAGE_6_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_6_CARRY_2_COMPACT_PK_PBS_KS: 93, "93": "PARAM_MESSAGE_6_CARRY_2_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_7_CARRY_1_COMPACT_PK_PBS_KS: 94, "94": "PARAM_MESSAGE_7_CARRY_1_COMPACT_PK_PBS_KS",
    PARAM_MESSAGE_1_CARRY_0: 95, "95": "PARAM_MESSAGE_1_CARRY_0",
    PARAM_MESSAGE_1_CARRY_1: 96, "96": "PARAM_MESSAGE_1_CARRY_1",
    PARAM_MESSAGE_2_CARRY_0: 97, "97": "PARAM_MESSAGE_2_CARRY_0",
    PARAM_MESSAGE_1_CARRY_2: 98, "98": "PARAM_MESSAGE_1_CARRY_2",
    PARAM_MESSAGE_2_CARRY_1: 99, "99": "PARAM_MESSAGE_2_CARRY_1",
    PARAM_MESSAGE_3_CARRY_0: 100, "100": "PARAM_MESSAGE_3_CARRY_0",
    PARAM_MESSAGE_1_CARRY_3: 101, "101": "PARAM_MESSAGE_1_CARRY_3",
    PARAM_MESSAGE_2_CARRY_2: 102, "102": "PARAM_MESSAGE_2_CARRY_2",
    PARAM_MESSAGE_3_CARRY_1: 103, "103": "PARAM_MESSAGE_3_CARRY_1",
    PARAM_MESSAGE_4_CARRY_0: 104, "104": "PARAM_MESSAGE_4_CARRY_0",
    PARAM_MESSAGE_1_CARRY_4: 105, "105": "PARAM_MESSAGE_1_CARRY_4",
    PARAM_MESSAGE_2_CARRY_3: 106, "106": "PARAM_MESSAGE_2_CARRY_3",
    PARAM_MESSAGE_3_CARRY_2: 107, "107": "PARAM_MESSAGE_3_CARRY_2",
    PARAM_MESSAGE_4_CARRY_1: 108, "108": "PARAM_MESSAGE_4_CARRY_1",
    PARAM_MESSAGE_5_CARRY_0: 109, "109": "PARAM_MESSAGE_5_CARRY_0",
    PARAM_MESSAGE_1_CARRY_5: 110, "110": "PARAM_MESSAGE_1_CARRY_5",
    PARAM_MESSAGE_2_CARRY_4: 111, "111": "PARAM_MESSAGE_2_CARRY_4",
    PARAM_MESSAGE_3_CARRY_3: 112, "112": "PARAM_MESSAGE_3_CARRY_3",
    PARAM_MESSAGE_4_CARRY_2: 113, "113": "PARAM_MESSAGE_4_CARRY_2",
    PARAM_MESSAGE_5_CARRY_1: 114, "114": "PARAM_MESSAGE_5_CARRY_1",
    PARAM_MESSAGE_6_CARRY_0: 115, "115": "PARAM_MESSAGE_6_CARRY_0",
    PARAM_MESSAGE_1_CARRY_6: 116, "116": "PARAM_MESSAGE_1_CARRY_6",
    PARAM_MESSAGE_2_CARRY_5: 117, "117": "PARAM_MESSAGE_2_CARRY_5",
    PARAM_MESSAGE_3_CARRY_4: 118, "118": "PARAM_MESSAGE_3_CARRY_4",
    PARAM_MESSAGE_4_CARRY_3: 119, "119": "PARAM_MESSAGE_4_CARRY_3",
    PARAM_MESSAGE_5_CARRY_2: 120, "120": "PARAM_MESSAGE_5_CARRY_2",
    PARAM_MESSAGE_6_CARRY_1: 121, "121": "PARAM_MESSAGE_6_CARRY_1",
    PARAM_MESSAGE_7_CARRY_0: 122, "122": "PARAM_MESSAGE_7_CARRY_0",
    PARAM_MESSAGE_1_CARRY_7: 123, "123": "PARAM_MESSAGE_1_CARRY_7",
    PARAM_MESSAGE_2_CARRY_6: 124, "124": "PARAM_MESSAGE_2_CARRY_6",
    PARAM_MESSAGE_3_CARRY_5: 125, "125": "PARAM_MESSAGE_3_CARRY_5",
    PARAM_MESSAGE_4_CARRY_4: 126, "126": "PARAM_MESSAGE_4_CARRY_4",
    PARAM_MESSAGE_5_CARRY_3: 127, "127": "PARAM_MESSAGE_5_CARRY_3",
    PARAM_MESSAGE_6_CARRY_2: 128, "128": "PARAM_MESSAGE_6_CARRY_2",
    PARAM_MESSAGE_7_CARRY_1: 129, "129": "PARAM_MESSAGE_7_CARRY_1",
    PARAM_MESSAGE_8_CARRY_0: 130, "130": "PARAM_MESSAGE_8_CARRY_0",
    PARAM_SMALL_MESSAGE_1_CARRY_1: 131, "131": "PARAM_SMALL_MESSAGE_1_CARRY_1",
    PARAM_SMALL_MESSAGE_2_CARRY_2: 132, "132": "PARAM_SMALL_MESSAGE_2_CARRY_2",
    PARAM_SMALL_MESSAGE_3_CARRY_3: 133, "133": "PARAM_SMALL_MESSAGE_3_CARRY_3",
    PARAM_SMALL_MESSAGE_4_CARRY_4: 134, "134": "PARAM_SMALL_MESSAGE_4_CARRY_4",
});

export class ShortintPublicKey {
    static __wrap(ptr) {
        const obj = Object.create(ShortintPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        ShortintPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ShortintPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_shortintpublickey_free(ptr, 0);
    }
}
if (Symbol.dispose) ShortintPublicKey.prototype[Symbol.dispose] = ShortintPublicKey.prototype.free;

export class TfheClientKey {
    static __wrap(ptr) {
        const obj = Object.create(TfheClientKey.prototype);
        obj.__wbg_ptr = ptr;
        TfheClientKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheClientKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfheclientkey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {TfheClientKey}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tfheclientkey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheClientKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheConfig} config
     * @returns {TfheClientKey}
     */
    static generate(config) {
        _assertClass(config, TfheConfig);
        const ret = wasm.tfheclientkey_generate(config.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheClientKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheConfig} config
     * @param {any} seed
     * @returns {TfheClientKey}
     */
    static generate_with_seed(config, seed) {
        _assertClass(config, TfheConfig);
        const ret = wasm.tfheclientkey_generate_with_seed(config.__wbg_ptr, seed);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheClientKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.tfheclientkey_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TfheClientKey.prototype[Symbol.dispose] = TfheClientKey.prototype.free;

export class TfheCompactPublicKey {
    static __wrap(ptr) {
        const obj = Object.create(TfheCompactPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        TfheCompactPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheCompactPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfhecompactpublickey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {TfheCompactPublicKey}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tfhecompactpublickey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompactPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {TfheCompactPublicKey}
     */
    static new(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.tfhecompactpublickey_new(client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompactPublicKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.tfhecompactpublickey_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TfheCompactPublicKey.prototype[Symbol.dispose] = TfheCompactPublicKey.prototype.free;

export class TfheCompressedCompactPublicKey {
    static __wrap(ptr) {
        const obj = Object.create(TfheCompressedCompactPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        TfheCompressedCompactPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheCompressedCompactPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfhecompressedcompactpublickey_free(ptr, 0);
    }
    /**
     * @returns {TfheCompactPublicKey}
     */
    decompress() {
        const ret = wasm.tfhecompressedcompactpublickey_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompactPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {TfheCompressedCompactPublicKey}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tfhecompressedcompactpublickey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompressedCompactPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {TfheCompressedCompactPublicKey}
     */
    static new(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.tfhecompressedcompactpublickey_new(client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompressedCompactPublicKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.tfhecompressedcompactpublickey_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TfheCompressedCompactPublicKey.prototype[Symbol.dispose] = TfheCompressedCompactPublicKey.prototype.free;

export class TfheCompressedPublicKey {
    static __wrap(ptr) {
        const obj = Object.create(TfheCompressedPublicKey.prototype);
        obj.__wbg_ptr = ptr;
        TfheCompressedPublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheCompressedPublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfhecompressedpublickey_free(ptr, 0);
    }
    /**
     * @returns {TfhePublicKey}
     */
    decompress() {
        const ret = wasm.tfhecompressedpublickey_decompress(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfhePublicKey.__wrap(ret[0]);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {TfheCompressedPublicKey}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tfhecompressedpublickey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompressedPublicKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {TfheCompressedPublicKey}
     */
    static new(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.tfhecompressedpublickey_new(client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompressedPublicKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.tfhecompressedpublickey_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TfheCompressedPublicKey.prototype[Symbol.dispose] = TfheCompressedPublicKey.prototype.free;

export class TfheCompressedServerKey {
    static __wrap(ptr) {
        const obj = Object.create(TfheCompressedServerKey.prototype);
        obj.__wbg_ptr = ptr;
        TfheCompressedServerKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheCompressedServerKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfhecompressedserverkey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {TfheCompressedServerKey}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tfhecompressedserverkey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompressedServerKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {TfheCompressedServerKey}
     */
    static new(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.tfhecompressedserverkey_new(client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfheCompressedServerKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.tfhecompressedserverkey_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TfheCompressedServerKey.prototype[Symbol.dispose] = TfheCompressedServerKey.prototype.free;

export class TfheConfig {
    static __wrap(ptr) {
        const obj = Object.create(TfheConfig.prototype);
        obj.__wbg_ptr = ptr;
        TfheConfigFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheConfigFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfheconfig_free(ptr, 0);
    }
}
if (Symbol.dispose) TfheConfig.prototype[Symbol.dispose] = TfheConfig.prototype.free;

export class TfheConfigBuilder {
    static __wrap(ptr) {
        const obj = Object.create(TfheConfigBuilder.prototype);
        obj.__wbg_ptr = ptr;
        TfheConfigBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfheConfigBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfheconfigbuilder_free(ptr, 0);
    }
    /**
     * @returns {TfheConfig}
     */
    build() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.tfheconfigbuilder_build(ptr);
        return TfheConfig.__wrap(ret);
    }
    /**
     * @returns {TfheConfigBuilder}
     */
    static default() {
        const ret = wasm.tfheconfigbuilder_default();
        return TfheConfigBuilder.__wrap(ret);
    }
    /**
     * @returns {TfheConfigBuilder}
     */
    static default_with_big_encryption() {
        const ret = wasm.tfheconfigbuilder_default_with_big_encryption();
        return TfheConfigBuilder.__wrap(ret);
    }
    /**
     * @returns {TfheConfigBuilder}
     */
    static default_with_small_encryption() {
        const ret = wasm.tfheconfigbuilder_default_with_small_encryption();
        return TfheConfigBuilder.__wrap(ret);
    }
    /**
     * @param {ShortintParameters} block_parameters
     * @returns {TfheConfigBuilder}
     */
    use_custom_parameters(block_parameters) {
        const ptr = this.__destroy_into_raw();
        _assertClass(block_parameters, ShortintParameters);
        const ret = wasm.tfheconfigbuilder_use_custom_parameters(ptr, block_parameters.__wbg_ptr);
        return TfheConfigBuilder.__wrap(ret);
    }
}
if (Symbol.dispose) TfheConfigBuilder.prototype[Symbol.dispose] = TfheConfigBuilder.prototype.free;

export class TfhePublicKey {
    static __wrap(ptr) {
        const obj = Object.create(TfhePublicKey.prototype);
        obj.__wbg_ptr = ptr;
        TfhePublicKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TfhePublicKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfhepublickey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} buffer
     * @returns {TfhePublicKey}
     */
    static deserialize(buffer) {
        const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tfhepublickey_deserialize(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfhePublicKey.__wrap(ret[0]);
    }
    /**
     * @param {TfheClientKey} client_key
     * @returns {TfhePublicKey}
     */
    static new(client_key) {
        _assertClass(client_key, TfheClientKey);
        const ret = wasm.tfhepublickey_new(client_key.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return TfhePublicKey.__wrap(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.tfhepublickey_serialize(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TfhePublicKey.prototype[Symbol.dispose] = TfhePublicKey.prototype.free;

/**
 * Decrypt an engine-produced result ciphertext. The engine encodes the trigger as 1/0,
 * matching the original server-side `client_key.decrypt::<u64>(ct) == 1`.
 * @param {string} ciphertext_hex
 * @param {string} client_key_hex
 * @returns {boolean}
 */
export function decrypt_result(ciphertext_hex, client_key_hex) {
    const ptr0 = passStringToWasm0(ciphertext_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(client_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.decrypt_result(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Derive the (compressed) server key from an existing client key. Deterministic, so the
 * browser only needs to persist the small client key and can re-derive the server key
 * whenever the backend needs it re-uploaded — avoids storing the ~20MB server key locally.
 * @param {string} client_key_hex
 * @returns {string}
 */
export function derive_server_key(client_key_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(client_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.derive_server_key(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Encrypt a price in cents (price * 100) with the given client key.
 * Returns the ciphertext as hex (bincode-serialized RadixCiphertext).
 * @param {bigint} price_cents
 * @param {string} client_key_hex
 * @returns {string}
 */
export function encrypt_price(price_cents, client_key_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(client_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.encrypt_price(price_cents, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generate a fresh FHE keypair. Returns `{ clientKey: hex, serverKey: hex }` where
 * serverKey is a *compressed* server key (the engine decompresses it before use).
 * Heavy: server-key generation is single-threaded on wasm.
 * @returns {any}
 */
export function generate_keys() {
    const ret = wasm.generate_keys();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

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
 * @param {string} seed_hex
 * @returns {string}
 */
export function generate_keys_from_seed(seed_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(seed_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.generate_keys_from_seed(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

export function init() {
    wasm.init();
}

export function init_panic_hook() {
    wasm.init_panic_hook();
}

export class tfhe {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        tfheFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tfhe_free(ptr, 0);
    }
}
if (Symbol.dispose) tfhe.prototype[Symbol.dispose] = tfhe.prototype.free;
export function __wbg_BigInt_8cda8462457fe42b(arg0, arg1) {
    const ret = BigInt(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_Error_fdd633d4bb5dd76a(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg_String_8564e559799eccda(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_add_4594b12c65ad8066(arg0, arg1) {
    const ret = arg0 + arg1;
    return ret;
}
export function __wbg___wbindgen_bigint_get_as_i64_d9e915702856f831(arg0, arg1) {
    const v = arg1;
    const ret = typeof(v) === 'bigint' ? v : undefined;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
}
export function __wbg___wbindgen_bit_and_e46f97b0660865e5(arg0, arg1) {
    const ret = arg0 & arg1;
    return ret;
}
export function __wbg___wbindgen_bit_or_7742b49e6a9e64c4(arg0, arg1) {
    const ret = arg0 | arg1;
    return ret;
}
export function __wbg___wbindgen_boolean_get_edaed31a367ce1bd(arg0) {
    const v = arg0;
    const ret = typeof(v) === 'boolean' ? v : undefined;
    return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
}
export function __wbg___wbindgen_debug_string_8a447059637473e2(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_is_function_acc5528be2b923f2(arg0) {
    const ret = typeof(arg0) === 'function';
    return ret;
}
export function __wbg___wbindgen_is_object_0beba4a1980d3eea(arg0) {
    const val = arg0;
    const ret = typeof(val) === 'object' && val !== null;
    return ret;
}
export function __wbg___wbindgen_is_string_1fca8072260dd261(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
}
export function __wbg___wbindgen_is_undefined_721f8decd50c87a3(arg0) {
    const ret = arg0 === undefined;
    return ret;
}
export function __wbg___wbindgen_jsval_eq_4e8c38722cb8ff51(arg0, arg1) {
    const ret = arg0 === arg1;
    return ret;
}
export function __wbg___wbindgen_lt_45bf45afccb5129e(arg0, arg1) {
    const ret = arg0 < arg1;
    return ret;
}
export function __wbg___wbindgen_neg_aad1c4d41cbe9602(arg0) {
    const ret = -arg0;
    return ret;
}
export function __wbg___wbindgen_shl_44e8d9b71c77150c(arg0, arg1) {
    const ret = arg0 << arg1;
    return ret;
}
export function __wbg___wbindgen_shr_81414fb0e82c0d39(arg0, arg1) {
    const ret = arg0 >> arg1;
    return ret;
}
export function __wbg___wbindgen_throw_ea4887a5f8f9a9db(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_call_5575218572ead796() { return handleError(function (arg0, arg1, arg2) {
    const ret = arg0.call(arg1, arg2);
    return ret;
}, arguments); }
export function __wbg_crypto_38df2bab126b63dc(arg0) {
    const ret = arg0.crypto;
    return ret;
}
export function __wbg_error_a6fa202b58aa1cd3(arg0, arg1) {
    let deferred0_0;
    let deferred0_1;
    try {
        deferred0_0 = arg0;
        deferred0_1 = arg1;
        console.error(getStringFromWasm0(arg0, arg1));
    } finally {
        wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
}
export function __wbg_fhebool_new(arg0) {
    const ret = FheBool.__wrap(arg0);
    return ret;
}
export function __wbg_fheint10_new(arg0) {
    const ret = FheInt10.__wrap(arg0);
    return ret;
}
export function __wbg_fheint128_new(arg0) {
    const ret = FheInt128.__wrap(arg0);
    return ret;
}
export function __wbg_fheint12_new(arg0) {
    const ret = FheInt12.__wrap(arg0);
    return ret;
}
export function __wbg_fheint14_new(arg0) {
    const ret = FheInt14.__wrap(arg0);
    return ret;
}
export function __wbg_fheint160_new(arg0) {
    const ret = FheInt160.__wrap(arg0);
    return ret;
}
export function __wbg_fheint16_new(arg0) {
    const ret = FheInt16.__wrap(arg0);
    return ret;
}
export function __wbg_fheint256_new(arg0) {
    const ret = FheInt256.__wrap(arg0);
    return ret;
}
export function __wbg_fheint2_new(arg0) {
    const ret = FheInt2.__wrap(arg0);
    return ret;
}
export function __wbg_fheint32_new(arg0) {
    const ret = FheInt32.__wrap(arg0);
    return ret;
}
export function __wbg_fheint4_new(arg0) {
    const ret = FheInt4.__wrap(arg0);
    return ret;
}
export function __wbg_fheint64_new(arg0) {
    const ret = FheInt64.__wrap(arg0);
    return ret;
}
export function __wbg_fheint6_new(arg0) {
    const ret = FheInt6.__wrap(arg0);
    return ret;
}
export function __wbg_fheint8_new(arg0) {
    const ret = FheInt8.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint10_new(arg0) {
    const ret = FheUint10.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint128_new(arg0) {
    const ret = FheUint128.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint12_new(arg0) {
    const ret = FheUint12.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint14_new(arg0) {
    const ret = FheUint14.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint160_new(arg0) {
    const ret = FheUint160.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint16_new(arg0) {
    const ret = FheUint16.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint256_new(arg0) {
    const ret = FheUint256.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint2_new(arg0) {
    const ret = FheUint2.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint32_new(arg0) {
    const ret = FheUint32.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint4_new(arg0) {
    const ret = FheUint4.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint64_new(arg0) {
    const ret = FheUint64.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint6_new(arg0) {
    const ret = FheUint6.__wrap(arg0);
    return ret;
}
export function __wbg_fheuint8_new(arg0) {
    const ret = FheUint8.__wrap(arg0);
    return ret;
}
export function __wbg_getRandomValues_c44a50d8cfdaebeb() { return handleError(function (arg0, arg1) {
    arg0.getRandomValues(arg1);
}, arguments); }
export function __wbg_length_589238bdcf171f0e(arg0) {
    const ret = arg0.length;
    return ret;
}
export function __wbg_msCrypto_bd5a034af96bcba6(arg0) {
    const ret = arg0.msCrypto;
    return ret;
}
export function __wbg_new_227d7c05414eb861() {
    const ret = new Error();
    return ret;
}
export function __wbg_new_2e117a478906f062() {
    const ret = new Object();
    return ret;
}
export function __wbg_new_with_length_9b650f44b5c44a4e(arg0) {
    const ret = new Uint8Array(arg0 >>> 0);
    return ret;
}
export function __wbg_node_84ea875411254db1(arg0) {
    const ret = arg0.node;
    return ret;
}
export function __wbg_process_44c7a14e11e9f69e(arg0) {
    const ret = arg0.process;
    return ret;
}
export function __wbg_prototypesetcall_d721637c7ca66eb8(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
}
export function __wbg_randomFillSync_6c25eac9869eb53c() { return handleError(function (arg0, arg1) {
    arg0.randomFillSync(arg1);
}, arguments); }
export function __wbg_require_b4edbdcf3e2a1ef0() { return handleError(function () {
    const ret = module.require;
    return ret;
}, arguments); }
export function __wbg_set_6be42768c690e380(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
}
export function __wbg_stack_3b0d974bbf31e44f(arg0, arg1) {
    const ret = arg1.stack;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg_static_accessor_GLOBAL_THIS_2fee5048bcca5938() {
    const ret = typeof globalThis === 'undefined' ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_GLOBAL_ce44e66a4935da8c() {
    const ret = typeof global === 'undefined' ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_SELF_44f6e0cb5e67cdad() {
    const ret = typeof self === 'undefined' ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_static_accessor_WINDOW_168f178805d978fe() {
    const ret = typeof window === 'undefined' ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
}
export function __wbg_subarray_b0e8ac4ed313fea8(arg0, arg1, arg2) {
    const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
    return ret;
}
export function __wbg_versions_276b2795b1c6a219(arg0) {
    const ret = arg0.versions;
    return ret;
}
export function __wbindgen_cast_0000000000000001(arg0) {
    // Cast intrinsic for `F64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `I128 -> Externref`.
    const ret = (BigInt.asUintN(64, arg0) | (arg1 << BigInt(64)));
    return ret;
}
export function __wbindgen_cast_0000000000000003(arg0) {
    // Cast intrinsic for `I64 -> Externref`.
    const ret = arg0;
    return ret;
}
export function __wbindgen_cast_0000000000000004(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
    const ret = getArrayU8FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000005(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000006(arg0, arg1) {
    // Cast intrinsic for `U128 -> Externref`.
    const ret = (BigInt.asUintN(64, arg0) | (BigInt.asUintN(64, arg1) << BigInt(64)));
    return ret;
}
export function __wbindgen_cast_0000000000000007(arg0) {
    // Cast intrinsic for `U64 -> Externref`.
    const ret = BigInt.asUintN(64, arg0);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const BooleanFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_boolean_free(ptr, 1));
const BooleanCiphertextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_booleanciphertext_free(ptr, 1));
const BooleanClientKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_booleanclientkey_free(ptr, 1));
const BooleanCompressedCiphertextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_booleancompressedciphertext_free(ptr, 1));
const BooleanCompressedServerKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_booleancompressedserverkey_free(ptr, 1));
const BooleanParametersFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_booleanparameters_free(ptr, 1));
const BooleanPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_booleanpublickey_free(ptr, 1));
const CompactFheBoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfhebool_free(ptr, 1));
const CompactFheBoolListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheboollist_free(ptr, 1));
const CompactFheInt10Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint10_free(ptr, 1));
const CompactFheInt10ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint10list_free(ptr, 1));
const CompactFheInt12Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint12_free(ptr, 1));
const CompactFheInt128Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint128_free(ptr, 1));
const CompactFheInt128ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint128list_free(ptr, 1));
const CompactFheInt12ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint12list_free(ptr, 1));
const CompactFheInt14Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint14_free(ptr, 1));
const CompactFheInt14ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint14list_free(ptr, 1));
const CompactFheInt16Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint16_free(ptr, 1));
const CompactFheInt160Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint160_free(ptr, 1));
const CompactFheInt160ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint160list_free(ptr, 1));
const CompactFheInt16ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint16list_free(ptr, 1));
const CompactFheInt2Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint2_free(ptr, 1));
const CompactFheInt256Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint256_free(ptr, 1));
const CompactFheInt256ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint256list_free(ptr, 1));
const CompactFheInt2ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint2list_free(ptr, 1));
const CompactFheInt32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint32_free(ptr, 1));
const CompactFheInt32ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint32list_free(ptr, 1));
const CompactFheInt4Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint4_free(ptr, 1));
const CompactFheInt4ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint4list_free(ptr, 1));
const CompactFheInt6Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint6_free(ptr, 1));
const CompactFheInt64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint64_free(ptr, 1));
const CompactFheInt64ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint64list_free(ptr, 1));
const CompactFheInt6ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint6list_free(ptr, 1));
const CompactFheInt8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint8_free(ptr, 1));
const CompactFheInt8ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheint8list_free(ptr, 1));
const CompactFheUint10Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint10_free(ptr, 1));
const CompactFheUint10ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint10list_free(ptr, 1));
const CompactFheUint12Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint12_free(ptr, 1));
const CompactFheUint128Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint128_free(ptr, 1));
const CompactFheUint128ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint128list_free(ptr, 1));
const CompactFheUint12ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint12list_free(ptr, 1));
const CompactFheUint14Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint14_free(ptr, 1));
const CompactFheUint14ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint14list_free(ptr, 1));
const CompactFheUint16Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint16_free(ptr, 1));
const CompactFheUint160Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint160_free(ptr, 1));
const CompactFheUint160ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint160list_free(ptr, 1));
const CompactFheUint16ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint16list_free(ptr, 1));
const CompactFheUint2Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint2_free(ptr, 1));
const CompactFheUint256Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint256_free(ptr, 1));
const CompactFheUint256ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint256list_free(ptr, 1));
const CompactFheUint2ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint2list_free(ptr, 1));
const CompactFheUint32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint32_free(ptr, 1));
const CompactFheUint32ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint32list_free(ptr, 1));
const CompactFheUint4Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint4_free(ptr, 1));
const CompactFheUint4ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint4list_free(ptr, 1));
const CompactFheUint6Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint6_free(ptr, 1));
const CompactFheUint64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint64_free(ptr, 1));
const CompactFheUint64ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint64list_free(ptr, 1));
const CompactFheUint6ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint6list_free(ptr, 1));
const CompactFheUint8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint8_free(ptr, 1));
const CompactFheUint8ListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compactfheuint8list_free(ptr, 1));
const CompressedFheBoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfhebool_free(ptr, 1));
const CompressedFheInt10Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint10_free(ptr, 1));
const CompressedFheInt12Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint12_free(ptr, 1));
const CompressedFheInt128Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint128_free(ptr, 1));
const CompressedFheInt14Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint14_free(ptr, 1));
const CompressedFheInt16Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint16_free(ptr, 1));
const CompressedFheInt160Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint160_free(ptr, 1));
const CompressedFheInt2Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint2_free(ptr, 1));
const CompressedFheInt256Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint256_free(ptr, 1));
const CompressedFheInt32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint32_free(ptr, 1));
const CompressedFheInt4Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint4_free(ptr, 1));
const CompressedFheInt6Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint6_free(ptr, 1));
const CompressedFheInt64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint64_free(ptr, 1));
const CompressedFheInt8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheint8_free(ptr, 1));
const CompressedFheUint10Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint10_free(ptr, 1));
const CompressedFheUint12Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint12_free(ptr, 1));
const CompressedFheUint128Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint128_free(ptr, 1));
const CompressedFheUint14Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint14_free(ptr, 1));
const CompressedFheUint16Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint16_free(ptr, 1));
const CompressedFheUint160Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint160_free(ptr, 1));
const CompressedFheUint2Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint2_free(ptr, 1));
const CompressedFheUint256Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint256_free(ptr, 1));
const CompressedFheUint32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint32_free(ptr, 1));
const CompressedFheUint4Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint4_free(ptr, 1));
const CompressedFheUint6Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint6_free(ptr, 1));
const CompressedFheUint64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint64_free(ptr, 1));
const CompressedFheUint8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_compressedfheuint8_free(ptr, 1));
const FheBoolFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fhebool_free(ptr, 1));
const FheInt10Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint10_free(ptr, 1));
const FheInt12Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint12_free(ptr, 1));
const FheInt128Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint128_free(ptr, 1));
const FheInt14Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint14_free(ptr, 1));
const FheInt16Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint16_free(ptr, 1));
const FheInt160Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint160_free(ptr, 1));
const FheInt2Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint2_free(ptr, 1));
const FheInt256Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint256_free(ptr, 1));
const FheInt32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint32_free(ptr, 1));
const FheInt4Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint4_free(ptr, 1));
const FheInt6Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint6_free(ptr, 1));
const FheInt64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint64_free(ptr, 1));
const FheInt8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheint8_free(ptr, 1));
const FheUint10Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint10_free(ptr, 1));
const FheUint12Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint12_free(ptr, 1));
const FheUint128Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint128_free(ptr, 1));
const FheUint14Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint14_free(ptr, 1));
const FheUint16Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint16_free(ptr, 1));
const FheUint160Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint160_free(ptr, 1));
const FheUint2Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint2_free(ptr, 1));
const FheUint256Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint256_free(ptr, 1));
const FheUint32Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint32_free(ptr, 1));
const FheUint4Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint4_free(ptr, 1));
const FheUint6Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint6_free(ptr, 1));
const FheUint64Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint64_free(ptr, 1));
const FheUint8Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fheuint8_free(ptr, 1));
const ShortintFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortint_free(ptr, 1));
const ShortintCiphertextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintciphertext_free(ptr, 1));
const ShortintClientKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintclientkey_free(ptr, 1));
const ShortintCompressedCiphertextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintcompressedciphertext_free(ptr, 1));
const ShortintCompressedPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintcompressedpublickey_free(ptr, 1));
const ShortintCompressedServerKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintcompressedserverkey_free(ptr, 1));
const ShortintParametersFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintparameters_free(ptr, 1));
const ShortintPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_shortintpublickey_free(ptr, 1));
const TfheClientKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfheclientkey_free(ptr, 1));
const TfheCompactPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfhecompactpublickey_free(ptr, 1));
const TfheCompressedCompactPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfhecompressedcompactpublickey_free(ptr, 1));
const TfheCompressedPublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfhecompressedpublickey_free(ptr, 1));
const TfheCompressedServerKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfhecompressedserverkey_free(ptr, 1));
const TfheConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfheconfig_free(ptr, 1));
const TfheConfigBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfheconfigbuilder_free(ptr, 1));
const TfhePublicKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfhepublickey_free(ptr, 1));
const tfheFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tfhe_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
