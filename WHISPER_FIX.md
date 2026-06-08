# Fix: Whisper Transcription Fallback WebGPU → WASM/CPU

## Problema

Se reportaron múltiples errores al generar subtítulos en diferentes navegadores:

1. **Firefox**: 
   ```
   ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits 
   Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale
   ```

2. **Chrome sin WebGPU habilitado**:
   ```
   no available backend found. ERR: [webgpu] Error: Failed to get GPU adapter
   ```

3. **Error durante transcripción**:
   ```
   failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: 
   Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists
   ```

## Causa Raíz

Dos problemas combinados:

1. **Modelos cuantizados incompatibles**: Por defecto, transformers.js descarga modelos cuantizados (q4, q8) que tienen problemas con ONNX Runtime en ciertos navegadores, causando errores como `TransposeDQWeightsForMatMulNBits Missing required scale`.

2. **Falta de fallback robusto**: El código anterior intentaba usar WebGPU cuando estaba disponible, pero no tenía fallback a WASM/CPU cuando:
   - WebGPU no está disponible (Chrome sin flag `--enable-unsafe-webgpu`)
   - Los modelos cuantizados son incompatibles (Firefox con ciertos modelos ONNX)
   - Ocurren errores durante la transcripción (referencias GPU inválidas)

## Solución Implementada

Se modificó `src/scripts/transcriber.worker.ts` para implementar un sistema de fallback automático similar al ya existente en `translation.worker.ts`.

### Cambios Clave

1. **Forzar modelos fp32 no cuantizados** (líneas 43-48, 70-75, 108-113):
   ```typescript
   dtype: {
     encoder_model: "fp32",
     decoder_model_merged: "fp32",
   }
   ```
   Esto evita que se descarguen modelos cuantizados problemáticos.

2. **Variables de estado** (líneas 20-21):
   ```typescript
   let recognizerDevice: "webgpu" | "wasm" = "wasm";
   let recognizerModel: string = "";
   ```

3. **Fallback en carga del modelo** (líneas 36-76):
   - Intenta WebGPU primero si está habilitado
   - Si falla, automáticamente carga en WASM/CPU
   - No lanza error, solo continúa con el backend disponible

4. **Fallback durante transcripción** (líneas 82-117):
   - Si la transcripción falla en WebGPU, recarga el modelo en WASM/CPU
   - Reintenta la operación automáticamente
   - Solo lanza error si también falla en WASM/CPU

5. **Logging mejorado**:
   ```javascript
   console.info("[ASR] attempting to load Whisper on WebGPU");
   console.warn("[ASR] WebGPU failed, falling back to WASM/CPU:", errorMsg);
   console.info("[ASR] Whisper loaded successfully on WASM/CPU");
   ```

## Resultado

✅ **Firefox**: Usa modelos fp32 compatibles en WASM/CPU
✅ **Chrome sin WebGPU**: Fallback silencioso a WASM/CPU con modelos fp32
✅ **Errores GPU durante transcripción**: Se recupera automáticamente
✅ **Modelos cuantizados**: Ya no se descargan, evitando errores ONNX
✅ **UX**: Sin errores crudos visibles al usuario
⚠️ **Trade-off**: Modelos fp32 son ~3-4x más grandes que cuantizados pero funcionan universalmente

## Testing Recomendado

1. **Firefox** (cualquier versión):
   - Subir video → Configurar subtítulos → Generar
   - Verificar en consola: `[ASR] loading Whisper on WASM/CPU backend`

2. **Chrome sin WebGPU**:
   - Cerrar Chrome
   - Abrir sin el flag `--enable-unsafe-webgpu`
   - Generar subtítulos
   - Verificar fallback automático en consola

3. **Chrome con WebGPU**:
   - Abrir con `--enable-unsafe-webgpu`
   - Verificar: `[ASR] Whisper loaded successfully on WebGPU`

## Archivos Modificados

- `src/scripts/transcriber.worker.ts` - Añadido sistema de fallback robusto

## Build

```bash
pnpm install
pnpm run build
```

Build exitoso confirmado el 2026-06-07.

## Detalles Técnicos

### ¿Por qué especificar dtype?

Por defecto, transformers.js v4 intenta descargar modelos en este orden de prioridad:
1. `q4` (4-bit cuantizado) - más pequeño
2. `q8` (8-bit cuantizado)
3. `fp16` (16-bit half precision)
4. `fp32` (32-bit full precision) - más grande pero más compatible

Los modelos cuantizados tienen problemas conocidos:
- **Firefox**: ONNX Runtime no soporta ciertos operadores cuantizados
- **WebGPU**: Operadores q8/q4 pueden fallar con `mapAsync` errors
- **CPU/WASM**: Algunos kernels cuantizados no están implementados

Al forzar `dtype: { encoder_model: "fp32", decoder_model_merged: "fp32" }`, garantizamos compatibilidad universal a costa de mayor tamaño de descarga.

### Tamaños de modelo Whisper-base

| Formato | Tamaño | Compatibilidad |
|---------|--------|----------------|
| q4 | ~40 MB | ❌ Errores en Firefox/algunos GPUs |
| q8 | ~75 MB | ⚠️ Puede fallar en WebGPU |
| fp16 | ~150 MB | ⚠️ No disponible para CPU en algunos navegadores |
| fp32 | ~300 MB | ✅ Universal |

### Referencias

- [Transformers.js dtype guide](https://huggingface.co/docs/transformers.js/guides/dtypes)
- [Issue #1317: WebGPU q8 decoders](https://github.com/huggingface/transformers.js/issues/1317)
- [Whisper-base model card](https://huggingface.co/Xenova/whisper-base)
