// js/image.helper.js

const SPECIFICATIONS = {
  richmenu: {
    formats: ['image/jpeg', 'image/png'],
    width: 2500,
    height: [1686, 843], // Can be one of these heights
    maxSize: 1024 * 1024, // 1MB
    aspectRatio: null,
  },
  imagemap: {
    formats: ['image/jpeg', 'image/png'],
    width: 1040,
    height: 1040,
    maxSize: 1024 * 1024, // 1MB
    aspectRatio: 1,
  },
};

/**
 * Reads a File object and returns its dimensions and a data URL.
 * @param {File} file The image file.
 * @returns {Promise<{img: HTMLImageElement, width: number, height: number, dataUrl: string}>}
 */
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        resolve({ img, width: img.width, height: img.height, dataUrl: e.target.result });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Compresses an image using the canvas element.
 * @param {HTMLImageElement} img The image element to compress.
 * @param {number} targetWidth The target width for the canvas.
 * @param {number} targetHeight The target height for the canvas.
 * @param {number} maxSize The maximum file size in bytes.
 * @returns {string|null} The compressed base64 data URL, or null if compression fails to meet the size.
 */
function compressImage(img, targetWidth, targetHeight, maxSize) {
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    // Attempt compression with JPEG format at different qualities
    for (let quality = 0.9; quality >= 0.5; quality -= 0.1) {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        // Estimate byte size from base64 length
        const sizeInBytes = dataUrl.length * (3 / 4);
        if (sizeInBytes <= maxSize) {
            return dataUrl;
        }
    }
    
    console.warn('[compressImage] Could not compress the image under the size limit.');
    return null; // Could not compress enough
}


/**
 * Validates an image file against specifications and attempts to compress if it's too large.
 * @param {File} file The image file to process.
 * @param {'richmenu' | 'imagemap'} type The type of image to validate against.
 * @returns {Promise<string>} A promise that resolves with the processed base64 data URL.
 * @throws {Error} Throws an error with a user-friendly message if validation fails.
 */
export async function processImageFor(file, type) {
  const spec = SPECIFICATIONS[type];
  if (!spec) {
    throw new Error('未知的圖片規格類型。');
  }

  // 1. Validate format
  if (!spec.formats.includes(file.type)) {
    throw new Error(`檔案格式錯誤。請上傳 ${spec.formats.map(f => f.replace('image/', '')).join(' 或 ')} 格式。`);
  }

  const { img, width, height, dataUrl } = await readImage(file);

  // 2. Validate dimensions
  if (spec.width && width !== spec.width) {
    throw new Error(`圖片寬度必須是 ${spec.width}px。`);
  }
  if (Array.isArray(spec.height)) {
    if (!spec.height.includes(height)) {
      throw new Error(`圖片高度必須是 ${spec.height.join('px 或 ')}px。`);
    }
  } else if (spec.height && height !== spec.height) {
    throw new Error(`圖片高度必須是 ${spec.height}px。`);
  }

  // 3. Validate file size and attempt compression
  if (file.size > spec.maxSize) {
    const compressedDataUrl = compressImage(img, width, height, spec.maxSize);
    if (compressedDataUrl) {
      return compressedDataUrl;
    } else {
      throw new Error(`圖片檔案過大 (超過 ${spec.maxSize / 1024 / 1024}MB)，且無法自動壓縮到指定大小內。`);
    }
  }

  // If all checks pass, return the original data URL
  return dataUrl;
}
