/* Diagnostic only. Refresh DirectWrite inside Electron's main process, without
 * a Node SDK or ABI-specific import library. Build instructions are in the audit.
 * This is NOT a production addon: it assumes Windows and Electron's N-API exports.
 */
#include <windows.h>
#include <stdint.h>

typedef void *napi_env;
typedef void *napi_value;
typedef void *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int (*create_function)(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
typedef int (*set_property)(napi_env, napi_value, const char *, napi_value);
typedef int (*create_uint)(napi_env, uint32_t, napi_value *);
typedef int (*throw_error)(napi_env, const char *, const char *);
static create_uint make_uint;
static throw_error fail;

static napi_value refresh(napi_env env, napi_callback_info info) {
  (void)info;
  GUID iid = {0xb859ee5a, 0xd838, 0x4b5b, {0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48}};
  typedef HRESULT (WINAPI *create_factory)(UINT, REFIID, void **);
  typedef HRESULT (WINAPI *get_collection)(void *, void **, BOOL);
  typedef UINT32 (WINAPI *get_count)(void *);
  typedef ULONG (WINAPI *release)(void *);
  void *factory = NULL, *collection = NULL;
  HMODULE library = LoadLibraryW(L"dwrite.dll");
  if (!library) { fail(env, NULL, "Cannot load dwrite.dll"); return NULL; }
  create_factory create = (create_factory)GetProcAddress(library, "DWriteCreateFactory");
  HRESULT hr = create ? create(0, &iid, &factory) : E_FAIL;
  UINT32 count = 0;
  if (SUCCEEDED(hr)) {
    void **vtable = *(void ***)factory;
    hr = ((get_collection)vtable[3])(factory, &collection, TRUE);
    if (SUCCEEDED(hr)) {
      void **methods = *(void ***)collection;
      count = ((get_count)methods[3])(collection);
      ((release)methods[2])(collection);
    }
    ((release)vtable[2])(factory);
  }
  FreeLibrary(library);
  if (FAILED(hr)) { fail(env, NULL, "DirectWrite font refresh failed"); return NULL; }
  napi_value result;
  make_uint(env, count, &result);
  return result;
}

__declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE executable = GetModuleHandleW(NULL);
  create_function make_function = (create_function)GetProcAddress(executable, "napi_create_function");
  set_property set = (set_property)GetProcAddress(executable, "napi_set_named_property");
  make_uint = (create_uint)GetProcAddress(executable, "napi_create_uint32");
  fail = (throw_error)GetProcAddress(executable, "napi_throw_error");
  if (!make_function || !set || !make_uint || !fail) return exports;
  napi_value function;
  make_function(env, "refresh", 7, refresh, NULL, &function);
  set(env, exports, "refresh", function);
  return exports;
}
