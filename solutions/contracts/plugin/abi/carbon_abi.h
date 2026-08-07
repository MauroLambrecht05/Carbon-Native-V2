/**
 * Carbon Native V2 - Native C-ABI Contract Header
 * Standard C binary interface for cross-language interop (C++, Zig, Rust, C#).
 */

#ifndef CARBON_NATIVE_ABI_H
#define CARBON_NATIVE_ABI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Result Codes */
typedef enum CarbonResult {
    CARBON_SUCCESS = 0,
    CARBON_ERROR_INVALID_ARGUMENT = 1,
    CARBON_ERROR_OUT_OF_MEMORY = 2,
    CARBON_ERROR_PLUGIN_INIT_FAILED = 3,
    CARBON_ERROR_COMPUTE_FAILED = 4,
    CARBON_ERROR_SECURITY_VIOLATION = 5,
    CARBON_ERROR_VERSION_MISMATCH = 6,
    CARBON_ERROR_UNKNOWN = 99
} CarbonResult;

/* Handle Types */
typedef uint64_t CarbonEngineHandle;
typedef uint64_t CarbonPluginHandle;

/* Memory Allocator Interface */
typedef struct CarbonAllocator {
    void* (*alloc)(size_t size, size_t alignment);
    void (*free)(void* ptr);
} CarbonAllocator;

/* Vector3 Struct (C-ABI Compatible) */
typedef struct CarbonVec3 {
    float x;
    float y;
    float z;
} CarbonVec3;

/* Core Compute Kernel Signature */
typedef CarbonResult (*FnCarbonComputeKernel)(
    const CarbonVec3* input_vector,
    CarbonVec3* output_vector,
    uint32_t count
);

/* Plugin Entry Point Interface */
typedef struct CarbonPluginInterface {
    const char* plugin_name;
    uint32_t abi_version;
    CarbonResult (*init)(CarbonPluginHandle handle, const CarbonAllocator* allocator);
    CarbonResult (*execute)(const uint8_t* flatbuffer_payload, size_t size);
    CarbonResult (*shutdown)(CarbonPluginHandle handle);
} CarbonPluginInterface;

#ifdef __cplusplus
}
#endif

#endif /* CARBON_NATIVE_ABI_H */
