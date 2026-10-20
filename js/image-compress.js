// Client-side photo optimiser for the admin uploader.
//
// Every photo is resized to 450px wide (aspect ratio kept, never cropped and
// never upscaled) and re-encoded as AVIF at a fixed high quality. Browsers
// cannot encode AVIF natively, so the encoder is a libavif/aom build compiled
// to WebAssembly; if it cannot be loaded the same canvas is re-encoded as
// WebP instead so an upload never fails.
(function (global) {
  'use strict';

  var TARGET_WIDTH = 450;
  var AVIF_QUALITY = 95;
  var WEBP_QUALITY = 0.82;
  // libavif speed: 0 is the slowest/best quality, 10 the fastest.
  var AVIF_SPEED = 6;

  // Tried in order. The first entry resolves its own .wasm; the second gets the
  // wasm handed to it explicitly because its bundle cannot resolve the path.
  var AVIF_SOURCES = [
    { url: 'https://esm.sh/@jsquash/avif@2.1.1' },
    {
      url: 'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/+esm',
      wasm: 'https://cdn.jsdelivr.net/npm/@jsquash/avif@2.1.1/codec/enc/avif_enc.wasm',
    },
  ];

  var avifEncoderPromise = null;

  // ===== HELPERS =====

  function sourceSize(source) {
    return {
      width: source.naturalWidth || source.width || 0,
      height: source.naturalHeight || source.height || 0,
    };
  }

  // Raw basename without the extension, used to match files against catalog
  // entries whatever the old extension was.
  function baseName(name) {
    var base = String(name || '').split(/[\\/]/).pop() || '';
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    return base.toLowerCase();
  }

  // Filesystem-safe stem for the newly written file.
  function safeStem(name) {
    var stem = baseName(name).replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
    return stem.slice(0, 80) || 'image';
  }

  // Keeps the aspect ratio, caps the width, and never scales an image up.
  function fitWidth(width, height, maxWidth) {
    if (!width || !height) throw new Error('That file does not look like an image.');
    if (width <= maxWidth) return { width: width, height: height };
    return { width: maxWidth, height: Math.max(1, Math.round(height * (maxWidth / width))) };
  }

  function makeCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function context2d(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser cannot process images on a canvas.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  // Halves the image repeatedly before the final draw. One giant downscale
  // aliases badly; stepping down keeps edges and fine detail clean.
  function drawResized(source, targetWidth, targetHeight) {
    var size = sourceSize(source);
    var current = source;
    var currentWidth = size.width;
    var currentHeight = size.height;

    while (currentWidth > targetWidth * 2 && currentHeight > targetHeight * 2) {
      var nextWidth = Math.max(targetWidth, Math.round(currentWidth / 2));
      var nextHeight = Math.max(targetHeight, Math.round(currentHeight / 2));
      var step = makeCanvas(nextWidth, nextHeight);
      context2d(step).drawImage(current, 0, 0, nextWidth, nextHeight);
      current = step;
      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    var canvas = makeCanvas(targetWidth, targetHeight);
    context2d(canvas).drawImage(current, 0, 0, targetWidth, targetHeight);
    return canvas;
  }

  function canvasToBlob(canvas, type, quality) {
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: type, quality: quality });
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('This browser could not encode the image.'));
      }, type, quality);
    });
  }

  function decodeViaImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That image could not be read.'));
      };
      img.src = url;
    });
  }

  async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        // "from-image" applies the EXIF orientation so portrait photos stay upright.
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (err) {
        try { return await createImageBitmap(file); } catch (ignored) { /* fall through */ }
      }
    }
    return decodeViaImageElement(file);
  }

  // ===== AVIF ENCODER =====

  async function loadAvifEncoder() {
    var lastError = null;

    for (var i = 0; i < AVIF_SOURCES.length; i++) {
      var source = AVIF_SOURCES[i];
      try {
        var mod = await import(source.url);
        var encode = mod.default || mod.encode;
        if (typeof encode !== 'function') throw new Error('encoder module has no encode()');

        if (source.wasm) {
          var wasm = await WebAssembly.compileStreaming(fetch(source.wasm));
          if (typeof mod.init === 'function') await mod.init(wasm);
        }

        // Prove the module really works before trusting it for a whole batch.
        var probe = await encode(new ImageData(2, 2), { quality: 40, speed: 10 });
        if (!probe || !probe.byteLength) throw new Error('encoder returned no data');

        return encode;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('The AVIF encoder could not be loaded.');
  }

  function getAvifEncoder() {
    if (!avifEncoderPromise) {
      avifEncoderPromise = loadAvifEncoder().catch(function (err) {
        avifEncoderPromise = null; // let a later upload retry the CDN
        throw err;
      });
    }
    return avifEncoderPromise;
  }

  // ===== ENCODING =====

    async function encodeAvif(imageData, encode) {
      var buffer = await encode(imageData, {
        quality: AVIF_QUALITY,
        qualityAlpha: AVIF_QUALITY,
        speed: AVIF_SPEED,
        subsample: 1, // 4:2:0
        denoiseLevel: 0,
      });
      return { blob: new Blob([buffer], { type: 'image/avif' }), quality: AVIF_QUALITY };
    }

    async function encodeWebp(canvas) {
      var blob = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
      return { blob: blob, quality: WEBP_QUALITY };
    }

  // ===== PUBLIC API =====

  // Resolves to { file, blob, name, width, height, bytes, format, ... } where
  // `file` is ready to drop straight into a FormData upload.
  async function compress(file, options) {
      options = options || {};

      var maxWidth = options.maxWidth || TARGET_WIDTH;

      var source = await decodeImage(file);
      var original = sourceSize(source);
      var target = fitWidth(original.width, original.height, maxWidth);

      var canvas;
      try {
        canvas = drawResized(source, target.width, target.height);
      } finally {
        if (typeof source.close === 'function') source.close();
      }

      var imageData = context2d(canvas).getImageData(0, 0, target.width, target.height);
      var result;

      try {
        var encode = await getAvifEncoder();
        result = await encodeAvif(imageData, encode);
        result.format = 'avif';
        result.mime = 'image/avif';
        result.extension = 'avif';
      } catch (err) {
        console.warn('[image-compress] AVIF unavailable, falling back to WebP:', err);
        result = await encodeWebp(canvas);
        result.format = 'webp';
        result.mime = 'image/webp';
        result.extension = 'webp';
        result.avifError = (err && err.message) || String(err);
      }

      var name = safeStem(file.name) + '.' + result.extension;
      var output = new File([result.blob], name, { type: result.mime, lastModified: Date.now() });

      return {
        file: output,
        blob: result.blob,
        name: name,
        width: target.width,
        height: target.height,
        bytes: result.blob.size,
        quality: result.quality,
        format: result.format,
        avifError: result.avifError || null,
        originalBytes: file.size,
        originalWidth: original.width,
        originalHeight: original.height,
      };
    }

  function formatBytes(size) {
    if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(size / 1024)) + ' KB';
  }

  // One-line summary for the file picker, e.g. "photo.avif · 450×600 · 34 KB".
    function describe(result) {
      if (!result) return '';
      var parts = [
        result.name,
        result.width + '\u00D7' + result.height,
        formatBytes(result.bytes),
      ];
      var text = parts.join(' \u00B7 ');
      if (result.format !== 'avif') {
        text += ' \u2014 WebP fallback, AVIF encoder unavailable';
      }
      return text;
    }

  global.ImageCompressor = {
      compress: compress,
      describe: describe,
      formatBytes: formatBytes,
      baseName: baseName,
      TARGET_WIDTH: TARGET_WIDTH,
    };
})(window);
