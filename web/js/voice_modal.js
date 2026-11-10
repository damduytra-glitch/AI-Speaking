import {
  ENROLLMENT_SENTENCES,
  fetchEmbeddingFromBackend,
  cosineSimilarity,
} from './voice.js';
import { escapeHtml, setLoading } from './ui_utils.js';

// =========================================================
// SHARED VOICE ENROLLMENT MODAL CONTROLLER
// Dùng chung giữa index.html (đăng ký mới) và dashboard.html (cập nhật giọng).
// =========================================================

function computeMeanNormalizedEmbedding(embeddings) {
  if (!embeddings || embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const meanEmb = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    let sum = 0;
    for (const emb of embeddings) {
      sum += emb[i];
    }
    meanEmb[i] = sum / embeddings.length;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += meanEmb[i] * meanEmb[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      meanEmb[i] /= norm;
    }
  }
  return Array.from(meanEmb);
}

export function initVoiceModal({
  onSave,
  showMismatchAlerts = true,
  guardBeforeSave = null,
} = {}) {
  const modalEl = document.getElementById('voiceModal');
  const dropzone = document.getElementById('voiceDropzone');
  const fileInput = document.getElementById('voiceFileInput');
  const removeUploadBtn = document.getElementById('removeUploadBtn');
  const saveVoiceBtn = document.getElementById('saveVoiceBtn');

  if (!modalEl || !saveVoiceBtn) {
    return { open: () => {}, reset: () => {} };
  }

  const defaultSaveTextHtml = saveVoiceBtn.querySelector('.btn-text')?.innerHTML || '<i class="bi bi-check-circle me-2"></i>Lưu Mẫu Giọng';
  let uploadedFiles = [];
  let uploadedEmbeddings = [];
  const recorderStates = {};

  function stopAllRecordingStreams() {
    for (const key of Object.keys(recorderStates)) {
      const st = recorderStates[key];
      if (st?.recorder && st.recorder.state === 'recording') {
        try { st.recorder.stop(); } catch (e) {}
      }
      if (st?.stream) {
        try { st.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      }
      delete recorderStates[key];
    }
  }

  function resetUploadState() {
    uploadedFiles = [];
    uploadedEmbeddings = [];
    document.getElementById('uploadedAudioPreview')?.classList.add('d-none');
    const titleEl = document.getElementById('uploadedFileName');
    if (titleEl) titleEl.textContent = '';
    const listContainer = document.getElementById('uploadedFilesList');
    if (listContainer) listContainer.innerHTML = '';
    if (fileInput) fileInput.value = '';
  }

  function resetSaveButton() {
    const textEl = saveVoiceBtn.querySelector('.btn-text');
    if (textEl) textEl.innerHTML = defaultSaveTextHtml;
    setLoading(saveVoiceBtn, false);
    saveVoiceBtn.disabled = true;
  }

  function resetAll() {
    stopAllRecordingStreams();
    resetUploadState();
    buildSentencesList();
    resetSaveButton();
  }

  function buildSentencesList() {
    const container = document.getElementById('sentencesList');
    if (!container) return;
    container.innerHTML = ENROLLMENT_SENTENCES.map((s, i) => `
      <div class="sentence-item p-3 rounded-3" id="sentence-${i}">
        <div class="d-flex align-items-start gap-3">
          <div class="sentence-idx">${i + 1}</div>
          <div class="flex-grow-1">
            <div class="sentence-text mb-2">"${escapeHtml(s)}"</div>
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button class="btn btn-sm btn-outline-primary record-btn" data-idx="${i}">
                <i class="bi bi-mic-fill me-1"></i>Ghi âm
              </button>
              <audio class="sentence-audio d-none" data-idx="${i}" controls></audio>
              <span class="badge bg-secondary status-badge" id="status-${i}">Chưa ghi</span>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.record-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleRecord(parseInt(btn.dataset.idx, 10)));
    });
  }

  function checkAllRecorded() {
    const allDone = ENROLLMENT_SENTENCES.every((_, i) => recorderStates[i]?.blob && recorderStates[i]?.embedding);
    if (allDone) saveVoiceBtn.disabled = false;
  }

  async function handleFileSelect(files) {
    if (!files || files.length === 0) return;
    const validFiles = Array.from(files).filter(f => {
      const isAudio = f.type.startsWith('audio/')
        || f.type === 'video/mp4'
        || /\.(wav|mp3|m4a|ogg|webm|aac)$/i.test(f.name);
      return isAudio && f.size <= 10 * 1024 * 1024;
    });
    if (validFiles.length === 0) {
      alert('Vui lòng chọn file audio hợp lệ (<10MB)!');
      return;
    }

    uploadedFiles = validFiles;
    uploadedEmbeddings = [];
    const titleEl = document.getElementById('uploadedFileName');
    if (titleEl) {
      titleEl.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Đang kiểm tra ${validFiles.length} file...`;
    }

    const listContainer = document.getElementById('uploadedFilesList');
    if (listContainer) {
      listContainer.innerHTML = validFiles.map((file, index) => {
        const url = URL.createObjectURL(file);
        return `
          <div class="d-flex align-items-center gap-3 p-2 rounded-2 border">
            <i class="bi bi-file-music text-primary fs-5"></i>
            <div class="flex-grow-1 overflow-hidden">
              <div class="fw-semibold text-truncate small">${index + 1}. ${escapeHtml(file.name)}</div>
              <audio controls class="w-100 mt-1" style="height: 30px;" src="${url}"></audio>
            </div>
          </div>
        `;
      }).join('');
    }

    document.getElementById('uploadedAudioPreview')?.classList.remove('d-none');
    saveVoiceBtn.disabled = true;

    try {
      if (validFiles.length === 1) {
        const emb = await fetchEmbeddingFromBackend(validFiles[0]);
        uploadedEmbeddings = [emb];
        if (titleEl) {
          titleEl.innerHTML = 'Đã chọn 1 file (Mẫu gốc) <i class="bi bi-check-circle-fill text-success"></i>';
        }
        saveVoiceBtn.disabled = false;
      } else {
        const embeddings = [];
        for (const file of validFiles) {
          embeddings.push(await fetchEmbeddingFromBackend(file));
        }
        let totalSim = 0;
        let count = 0;
        for (let i = 0; i < embeddings.length; i++) {
          for (let j = i + 1; j < embeddings.length; j++) {
            totalSim += cosineSimilarity(embeddings[i], embeddings[j]);
            count++;
          }
        }
        const avgSim = count > 0 ? (totalSim / count) : 0;
        const percent = Math.round(avgSim * 100);

        if (avgSim < 0.5) {
          if (titleEl) {
            titleEl.innerHTML = `<span class="text-danger">Đã chọn ${validFiles.length} file (Không khớp: ${percent}%) ❌</span>`;
          }
          if (showMismatchAlerts) {
            alert(`⚠️ Các file âm thanh không đồng nhất (Độ khớp: ${percent}%). Có thể do tiếng ồn hoặc nhiều người cùng nói. Vui lòng chọn lại!`);
          }
        } else {
          uploadedEmbeddings = embeddings;
          if (titleEl) {
            titleEl.innerHTML = `Đã chọn ${validFiles.length} file (Độ khớp: ${percent}%) <i class="bi bi-check-circle-fill text-success"></i>`;
          }
          saveVoiceBtn.disabled = false;
        }
      }
    } catch (err) {
      if (titleEl) {
        titleEl.innerHTML = '<span class="text-danger">Lỗi: File âm thanh không hợp lệ hoặc quá nhỏ! ❌</span>';
      }
      if (showMismatchAlerts) {
        alert('Lỗi kiểm tra giọng: ' + err.message);
      }
    }
  }

  async function toggleRecord(idx) {
    const state = recorderStates[idx];
    const btn = document.querySelector(`.record-btn[data-idx="${idx}"]`);
    const statusEl = document.getElementById(`status-${idx}`);
    const audioEl = document.querySelector(`.sentence-audio[data-idx="${idx}"]`);
    const item = document.getElementById(`sentence-${idx}`);

    if (!state || state.status !== 'recording') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          },
        });
        const recorder = new MediaRecorder(stream);
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });

          btn.innerHTML = '<i class="spinner-border spinner-border-sm me-1"></i>Kiểm tra...';
          btn.disabled = true;
          try {
            const emb = await fetchEmbeddingFromBackend(blob);

            const prevEmbeddings = [];
            for (let i = 0; i < ENROLLMENT_SENTENCES.length; i++) {
              if (i !== idx && recorderStates[i]?.embedding) {
                prevEmbeddings.push(recorderStates[i].embedding);
              }
            }

            let avgSim = null;
            if (prevEmbeddings.length > 0) {
              let totalSim = 0;
              for (const prevEmb of prevEmbeddings) {
                totalSim += cosineSimilarity(emb, prevEmb);
              }
              avgSim = totalSim / prevEmbeddings.length;
              if (avgSim < 0.5) {
                if (showMismatchAlerts) {
                  alert(`⚠️ Giọng đọc này không giống với các câu trước đó (Độ tương đồng: ${Math.round(avgSim * 100)}%). Vui lòng đọc lại!`);
                }
                delete recorderStates[idx].blob;
                delete recorderStates[idx].embedding;
                statusEl.className = 'badge bg-danger status-badge';
                statusEl.textContent = `Thất bại (${Math.round(avgSim * 100)}%) ❌`;
                item.classList.remove('recorded');
                btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Ghi lại';
                btn.className = 'btn btn-sm btn-outline-danger record-btn';
                return;
              }
            }

            recorderStates[idx].blob = blob;
            recorderStates[idx].embedding = emb;
            audioEl.src = URL.createObjectURL(blob);
            audioEl.classList.remove('d-none');
            statusEl.className = 'badge bg-success status-badge';
            statusEl.textContent = avgSim !== null
              ? `Đã ghi ✓ (Khớp ${Math.round(avgSim * 100)}%)`
              : 'Đã ghi ✓ (Mẫu gốc)';
            item.classList.add('recorded');
            btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Ghi lại';
            btn.className = 'btn btn-sm btn-outline-warning record-btn';
          } catch (err) {
            if (showMismatchAlerts) {
              alert('Lỗi kiểm tra giọng: ' + err.message);
            }
            if (recorderStates[idx]) {
              delete recorderStates[idx].blob;
              delete recorderStates[idx].embedding;
            }
            statusEl.className = 'badge bg-danger status-badge';
            statusEl.textContent = 'Lỗi ❌';
            btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Ghi lại';
            btn.className = 'btn btn-sm btn-outline-danger record-btn';
          } finally {
            btn.disabled = false;
            stream.getTracks().forEach(t => t.stop());
            checkAllRecorded();
          }
        };
        recorder.start();
        recorderStates[idx] = { status: 'recording', recorder, stream };
        btn.innerHTML = '<i class="bi bi-stop-fill me-1"></i>Dừng';
        btn.className = 'btn btn-sm btn-danger record-btn';
        statusEl.className = 'badge bg-danger status-badge';
        statusEl.textContent = '● Đang ghi...';
      } catch (e) {
        alert('Không thể truy cập microphone: ' + e.message);
      }
    } else {
      state.recorder.stop();
      state.status = 'done';
    }
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleFileSelect(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => handleFileSelect(fileInput.files));
  }

  if (removeUploadBtn) {
    removeUploadBtn.addEventListener('click', () => {
      resetUploadState();
      saveVoiceBtn.disabled = true;
    });
  }

  modalEl.addEventListener('hidden.bs.modal', () => {
    stopAllRecordingStreams();
    resetSaveButton();
  });

  saveVoiceBtn.addEventListener('click', async () => {
    if (guardBeforeSave && !guardBeforeSave()) return;
    setLoading(saveVoiceBtn, true);
    const btnTextEl = saveVoiceBtn.querySelector('.btn-text');
    let succeeded = false;
    try {
      const isUpload = document.getElementById('voiceUploadPanel')?.classList.contains('show');
      let finalEmbeddings = [];

      if (isUpload && uploadedFiles.length > 0) {
        if (uploadedEmbeddings.length === uploadedFiles.length) {
          finalEmbeddings = uploadedEmbeddings;
        } else {
          if (btnTextEl) btnTextEl.innerHTML = '<i class="bi bi-cpu me-2"></i>Đang trích xuất...';
          for (const file of uploadedFiles) {
            finalEmbeddings.push(await fetchEmbeddingFromBackend(file));
          }
        }
      } else {
        finalEmbeddings = ENROLLMENT_SENTENCES
          .map((_, i) => recorderStates[i]?.embedding)
          .filter(Boolean);
      }

      if (finalEmbeddings.length === 0) {
        throw new Error('Chưa có mẫu giọng hợp lệ để lưu.');
      }

      if (btnTextEl) btnTextEl.innerHTML = '<i class="bi bi-check-circle me-2"></i>Đang lưu...';
      const meanEmb = computeMeanNormalizedEmbedding(finalEmbeddings);

      if (onSave) {
        await onSave({ embeddings: meanEmb, voiceUrl: null });
      }
      succeeded = true;
      bootstrap.Modal.getInstance(modalEl)?.hide();
    } catch (e) {
      alert('Lỗi đăng ký: ' + e.message);
    } finally {
      if (btnTextEl) btnTextEl.innerHTML = defaultSaveTextHtml;
      setLoading(saveVoiceBtn, false);
      if (succeeded) {
        saveVoiceBtn.disabled = true;
      }
    }
  });

  return {
    open() {
      resetAll();
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    },
    reset: resetAll,
  };
}

