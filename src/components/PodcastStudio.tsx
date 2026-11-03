import React, { useState, useRef, useEffect } from 'react';
import { 
  Play, Pause, Square, Loader2, Plus, Trash2, Download, 
  Upload, Mic2, Save, Lock, RefreshCw, Volume2, 
  History, Clock, FileText, ChevronRight, FileArchive, Edit2,
  ArrowUp, ArrowDown, AlertCircle, Files, X, Sparkles
} from 'lucide-react';
import { Voice, PodcastSegment, PodcastProject } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import AudioVisualizer from './AudioVisualizer';
import JSZip from 'jszip';
import { 
  saveAudioBlob, 
  getAudioBlob, 
  deleteAudioBlob, 
  deleteProjectAudioBlobs, 
  clearAllAudioBlobs,
  clearAudioBlobsExceptProjects,
  cleanExpiredAudioBlobs,
  THREE_DAYS_MS
} from '../lib/audioStorage';

// 스크립트 텍스트를 세그먼트로 자동 분할하는 헬퍼 함수
function parseScriptToSegments(scriptText: string, type: 'problem' | 'paragraph' = 'problem'): PodcastSegment[] {
  if (!scriptText || !scriptText.trim()) {
    return [{ id: Math.random().toString(36).substr(2, 9), text: '', seed: 791120 }];
  }
  let parts: string[] = [];
  if (type === 'problem') {
    const splitRegex = /(?=(?:(?:(?:열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)\s*(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)|열|스무|서른|마흔|쉰|예순|일흔|여든|아흔|백)\s*번째|(?<!(?:열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)\s*)(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉)\s*번째|(?:[\d]+)\s*번째|(?:[\d]+)번)\s*문제)/g;
    parts = scriptText.split(splitRegex).map(p => p.trim()).filter(p => p.length > 0);
  } else {
    parts = scriptText.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  }
  if (parts.length === 0) {
    parts = [scriptText.trim()];
  } else {
    const lastPart = parts[parts.length - 1];
    const lines = lastPart.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 1) {
      const lastLine = lines.pop()!;
      parts[parts.length - 1] = lines.join('\n').trim();
      parts.push(lastLine.trim());
    }
  }
  const firstSegmentSeed = 791120;
  return parts.map(text => ({ 
    id: Math.random().toString(36).substr(2, 9), 
    text, 
    seed: firstSegmentSeed 
  }));
}

// 저장 파일명 포맷 유틸리티: 물결표(~, ～)를 하이픈(-)으로 치환
function formatAudioBaseName(name?: string): string {
  if (!name || !name.trim()) return 'podcast';
  return name.trim().replace(/[~～]/g, '-');
}

// WAV 인코딩 유틸리티
function encodeWAV(samples: Int16Array, sampleRate: number = 24000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (v: DataView, o: number, s: string) => { 
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); 
  };
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return new Blob([view], { type: 'audio/wav' });
}

function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

function normalizeInt16Samples(samples: Int16Array, targetPeak: number = 0.95): Int16Array {
  if (samples.length === 0) return samples;
  let maxVal = 0;
  for (let i = 0; i < samples.length; i++) {
    const absVal = Math.abs(samples[i]);
    if (absVal > maxVal) {
      maxVal = absVal;
    }
  }
  if (maxVal > 0) {
    const targetMax = Math.round(32767 * targetPeak);
    const multiplier = targetMax / maxVal;
    const normalizedSamples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let scaled = Math.round(samples[i] * multiplier);
      if (scaled > 32767) scaled = 32767;
      if (scaled < -32768) scaled = -32768;
      normalizedSamples[i] = scaled;
    }
    return normalizedSamples;
  }
  return samples;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const isWithin7Days = (p: PodcastProject): boolean => {
  const timestamp = p.updatedAt || p.createdAt || 0;
  if (!timestamp) return true;
  return Date.now() - timestamp <= SEVEN_DAYS_MS;
};

// 생성 후 3일이 경과한 오디오 캐시 판별 함수
export const isAudioExpired = (audioCreatedAt?: number, projectUpdatedAt?: number): boolean => {
  const timestamp = audioCreatedAt || projectUpdatedAt || 0;
  if (!timestamp) return false;
  return Date.now() - timestamp > THREE_DAYS_MS;
};

// 오늘 등록되었는지 판별하는 함수 (자정 기준 같은 날짜)
export const isRegisteredToday = (timestamp?: number): boolean => {
  if (!timestamp) return false;
  const target = new Date(timestamp);
  const now = new Date();
  return (
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate()
  );
};

export const isProjectRegisteredToday = (p: PodcastProject): boolean => {
  // 프로젝트 등록일(createdAt) 또는 등록일 누락 시 수정일 기준
  return isRegisteredToday(p.createdAt || p.updatedAt);
};

const PodcastStudio: React.FC<{ voices: Voice[]; onClose: () => void }> = ({ voices }) => {
  const defaultMaleVoice = voices.find(v => v.gender === 'Male')?.name || voices[0]?.name || 'Aoede';
  const [project, setProject] = useState<PodcastProject>({
    id: Math.random().toString(36).substr(2, 9), 
    name: '', 
    voiceName: defaultMaleVoice,
    segments: [{ id: '1', text: '', seed: 791120 }],
    script: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const [history, setHistory] = useState<PodcastProject[]>([]);
  const [batchProjectIds, setBatchProjectIds] = useState<string[]>([]);
  const [batchNotification, setBatchNotification] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [selectedGender, setSelectedGender] = useState<string>('Male');
  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState({ currentTime: 0, duration: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showClearAudioModal, setShowClearAudioModal] = useState(false);
  const [showCountAlertModal, setShowCountAlertModal] = useState<{ 
    show: boolean; 
    source: 'header' | 'modal' | 'export_individual' | 'export_full' | 'batch_all' | 'batch_single' | 'batch_item_full' | 'batch_item_individual' | 'batch_all_zips' | null;
    targetProjectId?: string;
    targetProject?: PodcastProject;
    non12Projects?: { id: string; name: string; count: number }[];
    totalSegmentsCount?: number;
    completedSegmentsCount?: number;
    titleName?: string;
  }>({ show: false, source: null });
  
  const multiFileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingFilesRef = useRef(false);
  const dragCounterRef = useRef(0);
  
  const totalSegments = project.segments.length;
  const segmentsWithText = project.segments.filter(s => s.text.trim());
  const totalSegmentsWithText = segmentsWithText.length;
  const completedSegmentsCount = segmentsWithText.filter(s => !!s.audioUrl || s.hasAudio).length;
  const isAllCompleted = totalSegmentsWithText > 0 && completedSegmentsCount === totalSegmentsWithText;
  const aggregateProgress = totalSegmentsWithText > 0 
    ? Math.floor(segmentsWithText.reduce((acc, s) => acc + (s.progress || 0), 0) / totalSegmentsWithText)
    : 0;

  // 여러 개 파일(에피소드) 일괄 처리 관련 계산 (배치 ID 고정 순서 유지)
  const isBatchMode = batchProjectIds.length > 1;
  const batchProjects = isBatchMode 
    ? batchProjectIds.map(id => {
        if (project.id === id) return project;
        return history.find(p => p.id === id);
      }).filter((p): p is PodcastProject => !!p)
    : [];
  const totalBatchSegmentsWithText = batchProjects.reduce((acc, p) => acc + p.segments.filter(s => s.text.trim()).length, 0);
  const completedBatchSegmentsCount = batchProjects.reduce((acc, p) => acc + p.segments.filter(s => s.text.trim() && (!!s.audioUrl || s.hasAudio)).length, 0);
  const isAllBatchCompleted = totalBatchSegmentsWithText > 0 && completedBatchSegmentsCount === totalBatchSegmentsWithText;

  // 실시간 진행 중인 세그먼트 목록 (현재 프로젝트 + 일괄 모드 프로젝트)
  const activeGeneratingSegments = project.segments
    .map((s, idx) => ({
      id: s.id,
      numberStr: String(idx).padStart(2, '0'),
      index: idx,
      progress: s.progress || 0,
      retryCountdown: s.retryCountdown,
      projectId: project.id,
      projectName: project.name || '현재 에피소드',
      episodeBadge: isBatchMode ? `#${batchProjectIds.indexOf(project.id) + 1}` : undefined
    }))
    .filter(item => {
      const seg = project.segments[item.index];
      return !!seg?.isGenerating || (seg?.retryCountdown !== undefined && seg?.retryCountdown > 0);
    });

  const batchGeneratingSegments = isBatchMode
    ? batchProjects.flatMap((p, pIdx) => {
        if (p.id === project.id) return [];
        return p.segments
          .map((s, sIdx) => ({
            id: s.id,
            numberStr: String(sIdx).padStart(2, '0'),
            index: sIdx,
            progress: s.progress || 0,
            retryCountdown: s.retryCountdown,
            projectId: p.id,
            projectName: p.name || `에피소드 ${pIdx + 1}`,
            episodeBadge: `#${pIdx + 1}`
          }))
          .filter(item => {
            const seg = p.segments[item.index];
            return !!seg?.isGenerating || (seg?.retryCountdown !== undefined && seg?.retryCountdown > 0);
          });
      })
    : [];

  const allGeneratingSegments = [...activeGeneratingSegments, ...batchGeneratingSegments];

  const scrollToSegment = (segmentId: string) => {
    const el = document.getElementById(`segment-${segmentId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-indigo-500', 'transition-all');
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-indigo-500');
      }, 1500);
    }
  };

  const restoreProjectAudio = async (p: PodcastProject): Promise<PodcastProject> => {
    const restoredSegments = await Promise.all(
      p.segments.map(async s => {
        // 3일이 경과한 오디오는 캐시 만료로 자동 정리
        const isExpired = isAudioExpired(s.audioCreatedAt, p.updatedAt || p.createdAt);
        if (isExpired) {
          await deleteAudioBlob(p.id, s.id);
          return { ...s, audioUrl: undefined, hasAudio: false, audioCreatedAt: undefined, progress: undefined, isGenerating: false };
        }
        const blob = await getAudioBlob(p.id, s.id);
        if (blob) {
          const url = URL.createObjectURL(blob);
          return { ...s, audioUrl: url, hasAudio: true, progress: 100 };
        }
        return { ...s, audioUrl: undefined, hasAudio: false, audioCreatedAt: undefined };
      })
    );
    return { ...p, segments: restoredSegments };
  };

  const getSegmentAudioBlob = async (projectId: string, segment: PodcastSegment): Promise<Blob | null> => {
    if (segment.audioUrl) {
      try {
        const resp = await fetch(segment.audioUrl);
        if (resp.ok) return await resp.blob();
      } catch (e) {}
    }
    return await getAudioBlob(projectId, segment.id);
  };
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef(0);
  const offsetRef = useRef(0);
  const animationFrameRef = useRef(0);
  const historyInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const lastSavedStateRef = useRef<string>("");
  const projectRef = useRef<PodcastProject>(project);
  const historyRef = useRef<PodcastProject[]>(history);
  const genProcesses = useRef<Record<string, { intervalId: any; delayTimerId?: any; skip: boolean }>>({});
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const abortAllRef = useRef(false);

  useEffect(() => {
    projectRef.current = project;
    if (project.id) {
      localStorage.setItem('podcast_current_project', JSON.stringify(project));
    }
  }, [project]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    // 모든 세그먼트가 처리되었는지 확인 (텍스트가 있는 모든 세그먼트에 audioUrl 또는 error가 있고, 현재 생성 중인 것이 없는지)
    const isComplete = project.segments.length > 0 && 
                      project.segments.every(s => !s.text.trim() || !!s.audioUrl || !!s.error) && 
                      !project.segments.some(s => s.isGenerating);
    
    if (isComplete) {
      // 이전 상태와 비교하여 중복 저장 방지 (id, 이름, 오디오 URL 리스트, 에러 리스트 기준)
      const fingerprint = JSON.stringify({
        id: project.id,
        name: project.name,
        audioUrls: project.segments.map(s => s.audioUrl),
        errors: project.segments.map(s => s.error)
      });

      if (lastSavedStateRef.current !== fingerprint && project.segments.some(s => s.audioUrl || s.error)) {
        saveToHistory();
        lastSavedStateRef.current = fingerprint;
      }
    }
  }, [project.segments, project.id, project.name]);

  useEffect(() => {
    const initApp = async () => {
      let rawHistory: PodcastProject[] = [];
      let rawCurrent: PodcastProject | null = null;

      const savedHistoryStr = localStorage.getItem('podcast_history');
      if (savedHistoryStr) {
        try {
          rawHistory = JSON.parse(savedHistoryStr);
        } catch (e) {}
      }

      const savedCurrentStr = localStorage.getItem('podcast_current_project');
      if (savedCurrentStr) {
        try {
          rawCurrent = JSON.parse(savedCurrentStr);
        } catch (e) {}
      }

      // 레거시 캐시 판별용 프로젝트 타임스탬프 맵 생성
      const projectTimestamps = new Map<string, number>();
      rawHistory.forEach(p => {
        if (p.id) projectTimestamps.set(p.id, p.updatedAt || p.createdAt || 0);
      });
      if (rawCurrent?.id) {
        projectTimestamps.set(rawCurrent.id, rawCurrent.updatedAt || rawCurrent.createdAt || 0);
      }

      // 1. IndexedDB에서 3일이 경과한 오디오 캐시 일괄 자동 삭제
      await cleanExpiredAudioBlobs(THREE_DAYS_MS, projectTimestamps);

      // 2. 프로젝트 히스토리는 7일 동안 보존 (7일 경과한 히스토리는 제거)
      if (rawHistory.length > 0) {
        const validHistory = rawHistory.filter(isWithin7Days);
        if (validHistory.length !== rawHistory.length) {
          const expired = rawHistory.filter(p => !isWithin7Days(p));
          expired.forEach(p => deleteProjectAudioBlobs(p.id));
        }
        // 3일 지난 오디오 캐시는 restoreProjectAudio에서 감지하여 세그먼트 상태 정리 및 삭제
        const restoredHistory = await Promise.all(validHistory.map(p => restoreProjectAudio(p)));
        setHistory(restoredHistory);
        localStorage.setItem('podcast_history', JSON.stringify(restoredHistory));
      }

      // 3. 현재 작업 중인 프로젝트 복원 (3일 지난 오디오는 자동 정리)
      if (rawCurrent) {
        const restoredCurrent = await restoreProjectAudio(rawCurrent);
        setProject(restoredCurrent);
        localStorage.setItem('podcast_current_project', JSON.stringify(restoredCurrent));
      }
    };

    initApp();

    const handleStorageChange = async (e: StorageEvent) => {
      if (e.key === 'podcast_history' && e.newValue) {
        try {
          const newHistory: PodcastProject[] = JSON.parse(e.newValue);
          const validHistory = newHistory.filter(isWithin7Days);
          const restored = await Promise.all(validHistory.map(p => restoreProjectAudio(p)));
          setHistory(restored);
        } catch (err) {}
      }
    };
    
    const handleGlobalDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleGlobalDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    };

    const handleDragCleanUp = () => {
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('dragover', handleGlobalDragOver);
    window.addEventListener('drop', handleGlobalDrop);
    window.addEventListener('dragend', handleDragCleanUp);

    return () => {
      stopAudio();
      if (audioContextRef.current?.state !== 'closed') audioContextRef.current?.close();
      cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('dragover', handleGlobalDragOver);
      window.removeEventListener('drop', handleGlobalDrop);
      window.removeEventListener('dragend', handleDragCleanUp);
    };
  }, []);

  // 탭 활성화 시 또는 주기적으로 3일 경과 오디오 캐시 자동 정리
  useEffect(() => {
    const runCacheMaintenance = async () => {
      const projectTimestamps = new Map<string, number>();
      history.forEach(p => projectTimestamps.set(p.id, p.updatedAt || p.createdAt || 0));
      if (project.id) projectTimestamps.set(project.id, project.updatedAt || project.createdAt || 0);
      await cleanExpiredAudioBlobs(THREE_DAYS_MS, projectTimestamps);
    };

    window.addEventListener('focus', runCacheMaintenance);
    const interval = setInterval(runCacheMaintenance, 30 * 60 * 1000); // 30분마다 확인
    return () => {
      window.removeEventListener('focus', runCacheMaintenance);
      clearInterval(interval);
    };
  }, [history, project.id, project.updatedAt, project.createdAt]);

  const saveToHistory = () => {
    setProject(current => {
      const timestamp = Date.now();
      const updatedProject = { 
        ...current, 
        updatedAt: timestamp,
        createdAt: current.createdAt || timestamp 
      };
      
      setHistory(prevHistory => {
        // 일주일(7일) 이내의 프로젝트들을 유지하며 최신 항목 업데이트
        const validPrev = prevHistory.filter(p => p.id !== current.id && isWithin7Days(p));
        const updatedHistory = [updatedProject, ...validPrev];
        localStorage.setItem('podcast_history', JSON.stringify(updatedHistory));
        localStorage.setItem('podcast_current_project', JSON.stringify(updatedProject));
        return updatedHistory;
      });
      
      return updatedProject;
    });
  };

  const loadFromHistory = async (p: PodcastProject) => {
    stopAudio();
    const restored = await restoreProjectAudio(p);
    setProject(restored);
    localStorage.setItem('podcast_current_project', JSON.stringify(restored));
  };

  const removeFromHistory = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteProjectAudioBlobs(id);
    const updatedHistory = history.filter(p => p.id !== id);
    setHistory(updatedHistory);
    localStorage.setItem('podcast_history', JSON.stringify(updatedHistory));
  };

  const handleClearAllAudioCache = async () => {
    stopAudio();

    // 1. 오늘 등록된 히스토리와 이전 히스토리 분리
    const todayHistory = history.filter(isProjectRegisteredToday);
    const removedHistory = history.filter(p => !isProjectRegisteredToday(p));
    const isCurrentProjectToday = isProjectRegisteredToday(project);

    // 2. 보존할 프로젝트 ID 목록 (오늘 등록된 히스토리 + 오늘 작업 중인 현재 프로젝트)
    const preservedProjectIds = new Set<string>();
    todayHistory.forEach(p => preservedProjectIds.add(p.id));
    if (isCurrentProjectToday && project.id) {
      preservedProjectIds.add(project.id);
    }

    // 3. 브라우저 메모리(Blob URL) 해제: 삭제 대상 이전 프로젝트의 오디오 URL 해제
    removedHistory.forEach(p => {
      p.segments.forEach(s => {
        if (s.audioUrl) {
          try { URL.revokeObjectURL(s.audioUrl); } catch (e) {}
        }
      });
    });

    if (!isCurrentProjectToday) {
      project.segments.forEach(s => {
        if (s.audioUrl) {
          try { URL.revokeObjectURL(s.audioUrl); } catch (e) {}
        }
      });
    }

    // 4. IndexedDB: 오늘 등록된 프로젝트 외의 모든 이전 오디오 캐시(WAV) 파일 삭제
    await clearAudioBlobsExceptProjects(preservedProjectIds);

    // 5. 히스토리 업데이트: 오늘 등록된 히스토리만 유지하고 이전 히스토리 모두 삭제
    setHistory(todayHistory);
    historyRef.current = todayHistory;
    localStorage.setItem('podcast_history', JSON.stringify(todayHistory));

    // 6. 현재 프로젝트 처리: 오늘 등록된 프로젝트가 아니면 새 기본 프로젝트로 초기화
    if (!isCurrentProjectToday) {
      const newInitialProject: PodcastProject = {
        id: Math.random().toString(36).substr(2, 9),
        name: '',
        voiceName: defaultMaleVoice,
        segments: [{ id: '1', text: '', seed: 791120 }],
        script: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      setProject(newInitialProject);
      projectRef.current = newInitialProject;
      localStorage.setItem('podcast_current_project', JSON.stringify(newInitialProject));
    }

    // 7. 일괄 작업 ID 목록에서도 삭제된 프로젝트 제외
    setBatchProjectIds(prev => prev.filter(id => preservedProjectIds.has(id)));

    // 8. 모달 닫기 및 결과 안내
    setShowClearAudioModal(false);
    const todayCount = preservedProjectIds.size;
    const removedCount = removedHistory.length + (!isCurrentProjectToday && project.name ? 1 : 0);

    setBatchNotification(
      todayCount > 0
        ? `🧹 오늘 등록된 히스토리(${todayCount}개)를 제외한 이전 캐시, 메모리, 오디오 파일 및 이전 히스토리(${removedCount}개)가 모두 삭제되었습니다.`
        : `🧹 오늘 등록된 히스토리가 없어 모든 이전 캐시, 파일, 히스토리가 초기화되었습니다.`
    );
    setTimeout(() => setBatchNotification(null), 5000);
  };

  const exportHistory = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(history));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "podcast_history_backup.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const importHistory = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      const r = new FileReader();
      r.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target?.result as string);
          if (Array.isArray(imported)) {
            const currentIds = new Set(history.map(p => p.id));
            const newItems = imported.filter((p: any) => !currentIds.has(p.id) && isWithin7Days(p));
            const updatedHistory = [...newItems, ...history.filter(isWithin7Days)];
            setHistory(updatedHistory);
            localStorage.setItem('podcast_history', JSON.stringify(updatedHistory));
          }
        } catch (e) {}
      };
      r.readAsText(f);
    }
  };

  const filteredVoices = voices.filter(v => selectedGender === 'All' || v.gender === selectedGender);

  // 성별 필터가 변결될 때 해당 성별의 첫 번째 성우로 자동 선택 (UI 불일치 방지)
  useEffect(() => {
    if (selectedGender !== 'All' && !filteredVoices.find(v => v.name === project.voiceName)) {
      const firstInGender = filteredVoices[0];
      if (firstInGender) {
        setProject(prev => ({ ...prev, voiceName: firstInGender.name }));
      }
    }
  }, [selectedGender]);

  // 스크립트 입력 시 초기 상태인 경우 자동으로 문제별 분할 적용
  useEffect(() => {
    const isInitialState = project.segments.length === 1 && 
                          !project.segments[0].text.trim() && 
                          !project.segments[0].audioUrl;
                          
    if (project.script?.trim() && isInitialState) {
      splitScriptToSegments('problem');
    }
  }, [project.script]);

  const updatePlaybackProgress = () => {
    if (audioContextRef.current && playingSegmentId) {
      const elapsed = audioContextRef.current.currentTime - startTimeRef.current + offsetRef.current;
      setPlaybackProgress(prev => ({ ...prev, currentTime: Math.min(elapsed, prev.duration) }));
      if (elapsed < playbackProgress.duration) animationFrameRef.current = requestAnimationFrame(updatePlaybackProgress);
    }
  };

  const stopAudio = () => {
    if (sourceNodeRef.current) { 
      try { sourceNodeRef.current.stop(); } catch (e) {} 
      sourceNodeRef.current = null; 
    }
    cancelAnimationFrame(animationFrameRef.current); 
    setPlayingSegmentId(null); 
    setPlaybackProgress({ currentTime: 0, duration: 0 }); 
    offsetRef.current = 0;
  };

  const addSegment = () => {
    const firstSegmentSeed = 791120;
    const newSegment = { id: Math.random().toString(36).substr(2, 9), text: '', seed: firstSegmentSeed };
    setProject(prev => ({ ...prev, segments: [...prev.segments, newSegment] }));
  };

  const insertSegment = (index: number) => {
    const firstSegmentSeed = 791120;
    const newSegment = { id: Math.random().toString(36).substr(2, 9), text: '', seed: firstSegmentSeed };
    const newSegments = [...project.segments];
    newSegments.splice(index, 0, newSegment);
    setProject(prev => ({ ...prev, segments: newSegments }));
  };

  const splitScriptToSegments = (type: 'problem' | 'paragraph') => {
    if (!project.script?.trim()) return;
    const newSegments = parseScriptToSegments(project.script, type);
    setProject(prev => ({ ...prev, segments: newSegments }));
  };

  const copyAllSegmentsText = () => {
    const allText = project.segments.map(s => s.text).join('\n\n');
    navigator.clipboard.writeText(allText);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  const deleteAllSegments = () => {
    deleteProjectAudioBlobs(project.id);
    setProject(prev => ({ ...prev, segments: [{ id: Math.random().toString(36).substr(2, 9), text: '', seed: 791120 }] }));
    setShowDeleteConfirm(false);
  };

  const removeSegment = (id: string) => { 
    if (project.segments.length > 1) {
      deleteAudioBlob(project.id, id);
      setProject(prev => ({ ...prev, segments: prev.segments.filter(s => s.id !== id) })); 
    }
  };

  // 모든 프로젝트(현재 프로젝트 및 히스토리 내 프로젝트)의 세그먼트 오디오를 동시/개별 생성하는 통합 함수
  const generateSegmentAudio = async (
    targetProjectId: string, 
    segmentId: string, 
    text: string, 
    seed: number, 
    voiceName: string, 
    retryCount = 0
  ): Promise<boolean> => {
    if (!text || !text.trim()) return false;
    const processKey = `${targetProjectId}_${segmentId}`;

    if (genProcesses.current[processKey]) {
      if (genProcesses.current[processKey].intervalId) clearInterval(genProcesses.current[processKey].intervalId);
      if (genProcesses.current[processKey].delayTimerId) clearInterval(genProcesses.current[processKey].delayTimerId);
    }
    
    genProcesses.current[processKey] = { intervalId: null, delayTimerId: null, skip: false };
    
    // 재시도 또는 새 생성 시작 시 이전 대기 알림 제거
    if (retryCount > 0) {
      setBatchNotification(null);
    }

    // 현재 활성 프로젝트 상태 업데이트
    setProject(prev => {
      if (prev.id === targetProjectId) {
        const next = {
          ...prev,
          segments: prev.segments.map(s => s.id === segmentId ? { 
            ...s, 
            audioUrl: undefined, 
            hasAudio: false, 
            isGenerating: true, 
            progress: retryCount > 0 ? 5 : 0, 
            error: undefined,
            retryCountdown: undefined
          } : s)
        };
        projectRef.current = next;
        return next;
      }
      return prev;
    });

    // 히스토리 내 프로젝트 상태 업데이트
    setHistory(prev => {
      const next = prev.map(p => {
        if (p.id === targetProjectId) {
          return {
            ...p,
            segments: p.segments.map(s => s.id === segmentId ? { 
              ...s, 
              audioUrl: undefined, 
              hasAudio: false, 
              isGenerating: true, 
              progress: retryCount > 0 ? 5 : 0, 
              error: undefined,
              retryCountdown: undefined
            } : s)
          };
        }
        return p;
      });
      historyRef.current = next;
      return next;
    });

    const progressInterval = setInterval(() => {
      setProject(prev => {
        if (prev.id === targetProjectId) {
          const next = {
            ...prev,
            segments: prev.segments.map(s => (s.id === segmentId && s.isGenerating && (s.progress || 0) < 90) ? { 
              ...s, 
              progress: Math.min(90, (s.progress || 0) + Math.random() * 10),
              retryCountdown: undefined,
              error: undefined
            } : s)
          };
          projectRef.current = next;
          return next;
        }
        return prev;
      });
      setHistory(prev => {
        const next = prev.map(p => {
          if (p.id === targetProjectId) {
            return {
              ...p,
              segments: p.segments.map(s => (s.id === segmentId && s.isGenerating && (s.progress || 0) < 90) ? { 
                ...s, 
                progress: Math.min(90, (s.progress || 0) + Math.random() * 10),
                retryCountdown: undefined,
                error: undefined
              } : s)
            };
          }
          return p;
        });
        historyRef.current = next;
        return next;
      });
    }, 800);

    genProcesses.current[processKey].intervalId = progressInterval;

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voiceName,
          seed,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `오디오 생성에 실패했습니다 (HTTP ${response.status})`);
      }

      const { audioData } = await response.json();
      if (!audioData) throw new Error("No audio data received from server");

      if (genProcesses.current[processKey]?.skip || abortAllRef.current) return false;
      
      clearInterval(progressInterval);

      const decodedBytes = decodeBase64(audioData);
      let pcmBuffer = decodedBytes.buffer;
      if (
        decodedBytes.length > 44 &&
        decodedBytes[0] === 0x52 &&
        decodedBytes[1] === 0x49 &&
        decodedBytes[2] === 0x46 &&
        decodedBytes[3] === 0x46
      ) {
        pcmBuffer = decodedBytes.buffer.slice(44);
      }

      const rawSamples = new Int16Array(pcmBuffer);
      const normalizedSamples = normalizeInt16Samples(rawSamples, 0.95);
      const wavBlob = encodeWAV(normalizedSamples, 24000);
      const now = Date.now();
      await saveAudioBlob(targetProjectId, segmentId, wavBlob, now);
      const audioUrl = URL.createObjectURL(wavBlob);

      setProject(prev => {
        if (prev.id === targetProjectId) {
          const next = {
            ...prev,
            updatedAt: now,
            segments: prev.segments.map(s => s.id === segmentId ? { 
              ...s, 
              audioUrl, 
              hasAudio: true, 
              audioCreatedAt: now,
              isGenerating: false, 
              progress: 100,
              error: undefined,
              retryCountdown: undefined
            } : s)
          };
          projectRef.current = next;
          return next;
        }
        return prev;
      });

      setHistory(prev => {
        const updated = prev.map(p => {
          if (p.id === targetProjectId) {
            return {
              ...p,
              updatedAt: now,
              segments: p.segments.map(s => s.id === segmentId ? { 
                ...s, 
                audioUrl, 
                hasAudio: true, 
                audioCreatedAt: now,
                isGenerating: false, 
                progress: 100,
                error: undefined,
                retryCountdown: undefined
              } : s)
            };
          }
          return p;
        });
        historyRef.current = updated;
        localStorage.setItem('podcast_history', JSON.stringify(updated));
        return updated;
      });

      return true;

    } catch (err) { 
      if (genProcesses.current[processKey]?.skip || abortAllRef.current) return false;
      clearInterval(progressInterval); 
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      const isSpendingCap = errorMessage.includes('지출 한도') || 
                            errorMessage.toLowerCase().includes('spending cap');

      // 429 Quota Exceeded or Resource Exhausted or rate limit
      const isQuotaError = !isSpendingCap && (
        errorMessage.includes('429') || 
        errorMessage.toLowerCase().includes('quota') || 
        errorMessage.toLowerCase().includes('exhausted') ||
        errorMessage.toLowerCase().includes('rate limit') ||
        errorMessage.toLowerCase().includes('too many requests') ||
        errorMessage.toLowerCase().includes('resource_exhausted')
      );

      // 월간 지출 한도 초과(Spending Cap)의 경우 1분 대기 재시도가 무의미하므로 즉시 안내 표시
      if (isSpendingCap) {
        setBatchNotification("⚠️ Google AI Studio 프로젝트의 월간 지출 한도(Monthly Spending Cap)가 초과되었습니다. ai.studio/spend 에서 한도를 상향하거나 새 프로젝트로 실행해야 합니다.");
      }

      // 할당량 초과(429) 시 1분(60초) 쿨다운 대기 후 재생성, 일반 일시 오류는 3초 후 빠른 재시도 (최대 3회)
      // 월간 지출 한도 초과인 경우에는 재시도하지 않고 즉시 종료
      const maxRetries = isSpendingCap ? 0 : 3;
      if (retryCount < maxRetries && !genProcesses.current[processKey]?.skip && !abortAllRef.current) {
        const delaySeconds = isQuotaError ? 60 : 3;
        let remainingSec = delaySeconds;

        const updateCountdown = (sec: number) => {
          setProject(prev => {
            if (prev.id === targetProjectId) {
              const next = {
                ...prev,
                segments: prev.segments.map(s => s.id === segmentId ? {
                  ...s,
                  isGenerating: false,
                  progress: 0,
                  retryCountdown: sec,
                  error: undefined
                } : s)
              };
              projectRef.current = next;
              return next;
            }
            return prev;
          });

          setHistory(prev => {
            const next = prev.map(p => {
              if (p.id === targetProjectId) {
                return {
                  ...p,
                  segments: p.segments.map(s => s.id === segmentId ? {
                    ...s,
                    isGenerating: false,
                    progress: 0,
                    retryCountdown: sec,
                    error: undefined
                  } : s)
                };
              }
              return p;
            });
            historyRef.current = next;
            return next;
          });
        };

        updateCountdown(remainingSec);

        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (genProcesses.current[processKey]?.skip || abortAllRef.current) {
              clearInterval(timer);
              resolve();
              return;
            }
            remainingSec--;
            if (remainingSec <= 0) {
              clearInterval(timer);
              resolve();
            } else {
              updateCountdown(remainingSec);
            }
          }, 1000);

          if (genProcesses.current[processKey]) {
            genProcesses.current[processKey].delayTimerId = timer;
          }
        });

        if (genProcesses.current[processKey]?.skip || abortAllRef.current) return false;

        // 1분 지연 완료 후 대기 알림 초기화 및 새로운 생성 시작
        setBatchNotification(null);
        return generateSegmentAudio(targetProjectId, segmentId, text, seed, voiceName, retryCount + 1);
      }

      const finalErrorMsg = isSpendingCap
        ? '월간 지출 한도 초과 (ai.studio/spend)'
        : isQuotaError 
          ? '할당량 초과 (1분 딜레이 재시도 모두 소진)' 
          : `생성 실패: ${errorMessage}`;

      setProject(prev => {
        if (prev.id === targetProjectId) {
          const next = { 
            ...prev, 
            segments: prev.segments.map(s => s.id === segmentId ? { 
              ...s, 
              isGenerating: false, 
              progress: 0, 
              retryCountdown: undefined, 
              error: finalErrorMsg 
            } : s) 
          };
          projectRef.current = next;
          return next;
        }
        return prev;
      });

      setHistory(prev => {
        const updated = prev.map(p => {
          if (p.id === targetProjectId) {
            return { 
              ...p, 
              segments: p.segments.map(s => s.id === segmentId ? { 
                ...s, 
                isGenerating: false, 
                progress: 0, 
                retryCountdown: undefined, 
                error: finalErrorMsg 
              } : s) 
            };
          }
          return p;
        });
        historyRef.current = updated;
        localStorage.setItem('podcast_history', JSON.stringify(updated));
        return updated;
      });

      return false;
    }
  };

  const generateAudio = (segmentId: string): Promise<boolean> => {
    const segment = project.segments.find(s => s.id === segmentId);
    if (!segment) return Promise.resolve(false);
    return generateSegmentAudio(project.id, segment.id, segment.text, segment.seed, project.voiceName);
  };

  const stopGeneration = (segmentId: string) => {
    const processKey = `${project.id}_${segmentId}`;
    if (genProcesses.current[processKey]) {
      clearInterval(genProcesses.current[processKey].intervalId);
      if (genProcesses.current[processKey].delayTimerId) {
        clearInterval(genProcesses.current[processKey].delayTimerId);
      }
      genProcesses.current[processKey].skip = true;
      delete genProcesses.current[processKey];
    }
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s => s.id === segmentId ? { ...s, isGenerating: false, progress: 0, retryCountdown: undefined } : s)
    }));
  };

  // 단일 프로젝트 전체 세그먼트 생성 (세그먼트 2개씩 병렬 생성 후, 미완료 세그먼트 순차 재시도)
  // 기존에 오디오 생성이 완료된 세그먼트는 그대로 유지하고 미완료된 세그먼트만 생성
  const generateAllAudio = async () => {
    // 💡 기존 오디오가 이미 생성 완료된 것은 건너뛰고, 미완료 세그먼트만 필터링
    const segmentsToGenerate = project.segments.filter(
      s => s.text.trim().length > 0 && !s.isGenerating && !(s.hasAudio || !!s.audioUrl)
    );

    if (segmentsToGenerate.length === 0) {
      setBatchNotification("이미 모든 세그먼트의 오디오 생성이 완료되었습니다.");
      setTimeout(() => setBatchNotification(null), 3000);
      return;
    }

    setIsGeneratingAll(true);
    abortAllRef.current = false;
    
    // 1차: 세그먼트 2개씩 병렬 생성
    const CONCURRENCY = 2;
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < segmentsToGenerate.length && !abortAllRef.current) {
        const itemIndex = currentIndex++;
        if (itemIndex >= segmentsToGenerate.length) break;
        const s = segmentsToGenerate[itemIndex];
        await generateAudio(s.id);
      }
    };

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, segmentsToGenerate.length) }, 
      () => worker()
    );
    await Promise.all(workers);
    
    // 모든 세그먼트 생성 후, 완료되면 생성 실패한 세그먼트만 순차적으로 한번더 다시 생성
    if (!abortAllRef.current) {
      const failedSegments = projectRef.current.segments.filter(
        s => s.text.trim().length > 0 && (!s.audioUrl && !s.hasAudio || !!s.error)
      );

      if (failedSegments.length > 0) {
        setBatchNotification(`⚠️ 1차 생성 완료: 생성 실패한 ${failedSegments.length}개 세그먼트를 순차적으로 다시 생성합니다...`);
        
        for (let i = 0; i < failedSegments.length; i++) {
          if (abortAllRef.current) break;
          const failedSeg = failedSegments[i];
          setBatchNotification(`🔄 실패 세그먼트 순차 재시도 중 (${i + 1}/${failedSegments.length})...`);
          
          await generateSegmentAudio(
            projectRef.current.id,
            failedSeg.id,
            failedSeg.text,
            failedSeg.seed,
            projectRef.current.voiceName
          );

          // API 요청 간 안정성을 위한 지연 (순차적 1회 재시도)
          if (!abortAllRef.current && i < failedSegments.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        const remainingFailed = projectRef.current.segments.filter(
          s => s.text.trim().length > 0 && (!s.audioUrl && !s.hasAudio || !!s.error)
        );

        if (remainingFailed.length === 0) {
          setBatchNotification(`🎉 모든 세그먼트 오디오 생성이 완료되었습니다!`);
        } else {
          setBatchNotification(`⚠️ 재시도 완료: ${remainingFailed.length}개 세그먼트가 여전히 실패했습니다. 개별 '다시 생성'을 시도해주세요.`);
        }
        setTimeout(() => setBatchNotification(null), 5000);
      } else {
        setBatchNotification(`🎉 모든 세그먼트 오디오 생성이 완료되었습니다!`);
        setTimeout(() => setBatchNotification(null), 4000);
      }
    }
    
    setIsGeneratingAll(false);
    saveToHistory();
  };

  // 여러 프로젝트 일괄 생성: 파일 하나씩 순차 완료 후 다음 파일로 진행, 각 파일 내에서는 세그먼트를 2개씩 동시 생성
  // 기존에 오디오 생성이 완료된 세그먼트는 유지하고 미완료 세그먼트만 생성
  const generateBatchProjects = async (targetProjectIds: string[]) => {
    setIsGeneratingAll(true);
    abortAllRef.current = false;

    const allProjectsMap = new Map<string, PodcastProject>();
    if (projectRef.current.id) allProjectsMap.set(projectRef.current.id, projectRef.current);
    historyRef.current.forEach(p => allProjectsMap.set(p.id, p));

    const targetProjects = targetProjectIds
      .map(id => allProjectsMap.get(id))
      .filter((p): p is PodcastProject => !!p);

    // 전체 프로젝트 중 생성할 세그먼트가 남아있는지 확인
    const totalRemaining = targetProjects.reduce((acc, p) => {
      const freshP = (projectRef.current.id === p.id)
        ? projectRef.current
        : historyRef.current.find(hp => hp.id === p.id) || p;
      return acc + freshP.segments.filter(s => s.text.trim().length > 0 && !(s.hasAudio || !!s.audioUrl)).length;
    }, 0);

    if (totalRemaining === 0) {
      setBatchNotification("모든 파일의 세그먼트 오디오 생성이 이미 완료되어 있습니다.");
      setIsGeneratingAll(false);
      setTimeout(() => setBatchNotification(null), 3000);
      return;
    }

    // 1단계: 파일 한 개씩 순차적으로 진행 (한 파일이 완전히 완료되면 다음 파일로 이동)
    // 각 파일 내에서는 미완료 세그먼트를 2개씩 동시 생성
    for (let pIdx = 0; pIdx < targetProjects.length; pIdx++) {
      if (abortAllRef.current) break;
      const proj = targetProjects[pIdx];

      // 최신 프로젝트 상태 가져오기
      const freshProj = (projectRef.current.id === proj.id)
        ? projectRef.current
        : historyRef.current.find(p => p.id === proj.id) || proj;

      // 💡 기존 오디오가 이미 완료된 세그먼트는 제외하고 미완료 세그먼트만 선택
      const segsToGenerate = freshProj.segments.filter(
        s => s.text.trim().length > 0 && !s.isGenerating && !(s.hasAudio || !!s.audioUrl)
      );
      
      if (segsToGenerate.length > 0) {
        setBatchNotification(`📁 [${pIdx + 1}/${targetProjects.length}] '${freshProj.name || `에피소드 ${pIdx + 1}`}' 미완료 ${segsToGenerate.length}개 세그먼트 생성 중...`);
        
        const CONCURRENCY = 2;
        let currentIndex = 0;

        const worker = async () => {
          while (currentIndex < segsToGenerate.length && !abortAllRef.current) {
            const itemIndex = currentIndex++;
            if (itemIndex >= segsToGenerate.length) break;
            const seg = segsToGenerate[itemIndex];
            await generateSegmentAudio(
              freshProj.id, 
              seg.id, 
              seg.text, 
              seg.seed, 
              freshProj.voiceName || defaultMaleVoice
            );
          }
        };

        const workers = Array.from(
          { length: Math.min(CONCURRENCY, segsToGenerate.length) }, 
          () => worker()
        );
        // 이 파일의 모든 세그먼트 생성이 완료될 때까지 대기
        await Promise.all(workers);
      }

      // 한 파일이 완료된 후 다음 파일 넘어가기 전 안전 지연
      if (!abortAllRef.current && pIdx < targetProjects.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // 2단계: 모든 파일 생성 완료 후, 생성완료 안된 세그먼트만 다시 한번 순차적으로 재시도
    if (!abortAllRef.current) {
      const allProjects = [projectRef.current, ...historyRef.current];
      const failedTasks: { projectId: string; segmentId: string; text: string; seed: number; voiceName: string; episodeName: string }[] = [];

      for (let pIdx = 0; pIdx < targetProjectIds.length; pIdx++) {
        const projId = targetProjectIds[pIdx];
        const proj = allProjects.find(p => p.id === projId);
        if (!proj) continue;
        const failedSegs = proj.segments.filter(s => s.text.trim().length > 0 && (!s.audioUrl && !s.hasAudio || !!s.error));
        for (const fs of failedSegs) {
          failedTasks.push({
            projectId: proj.id,
            segmentId: fs.id,
            text: fs.text,
            seed: fs.seed,
            voiceName: proj.voiceName || defaultMaleVoice,
            episodeName: proj.name || `에피소드 ${pIdx + 1}`
          });
        }
      }

      if (failedTasks.length > 0 && !abortAllRef.current) {
        setBatchNotification(`⚠️ 전체 1차 완료: 미완료된 ${failedTasks.length}개 세그먼트를 다시 생성합니다...`);
        for (let i = 0; i < failedTasks.length; i++) {
          if (abortAllRef.current) break;
          const t = failedTasks[i];
          setBatchNotification(`🔄 [${t.episodeName}] 미완료 세그먼트 재시도 중 (${i + 1}/${failedTasks.length})...`);
          await generateSegmentAudio(t.projectId, t.segmentId, t.text, t.seed, t.voiceName);
          if (!abortAllRef.current && i < failedTasks.length - 1) {
            await new Promise(r => setTimeout(r, 1200));
          }
        }

        const remainingFailed = [projectRef.current, ...historyRef.current]
          .filter(p => targetProjectIds.includes(p.id))
          .reduce((acc, p) => acc + p.segments.filter(s => s.text.trim().length > 0 && (!s.audioUrl && !s.hasAudio || !!s.error)).length, 0);

        if (remainingFailed === 0) {
          setBatchNotification(`🎉 모든 파일의 세그먼트 생성이 성공적으로 완료되었습니다!`);
        } else {
          setBatchNotification(`⚠️ 재시도 완료: ${remainingFailed}개 세그먼트가 완료되지 않았습니다.`);
        }
        setTimeout(() => setBatchNotification(null), 5000);
      } else if (!abortAllRef.current) {
        setBatchNotification(`🎉 모든 파일의 세그먼트 생성이 성공적으로 완료되었습니다!`);
        setTimeout(() => setBatchNotification(null), 4000);
      }
    }
    
    setIsGeneratingAll(false);
  };

  const stopAllGeneration = () => {
    abortAllRef.current = true;
    Object.keys(genProcesses.current).forEach(key => {
      clearInterval(genProcesses.current[key].intervalId);
      if (genProcesses.current[key].delayTimerId) {
        clearInterval(genProcesses.current[key].delayTimerId);
      }
      genProcesses.current[key].skip = true;
    });
    genProcesses.current = {};
    
    setProject(prev => {
      const next = {
        ...prev,
        segments: prev.segments.map(s => ({ ...s, isGenerating: false, progress: 0, retryCountdown: undefined }))
      };
      projectRef.current = next;
      return next;
    });
    
    setHistory(prev => {
      const next = prev.map(p => ({
        ...p,
        segments: p.segments.map(s => ({ ...s, isGenerating: false, progress: 0, retryCountdown: undefined }))
      }));
      historyRef.current = next;
      return next;
    });

    setIsGeneratingAll(false);
  };

  // 텍스트 원문(또는 단일 파일 텍스트)을 로드하여 세그먼트까지 자동 파싱하는 공통 함수
  const handleRawTextDrop = (rawText: string, defaultName?: string) => {
    if (!rawText || !rawText.trim()) return;
    const segments = parseScriptToSegments(rawText);
    deleteProjectAudioBlobs(project.id);
    const now = Date.now();
    const cleanName = defaultName ? defaultName.replace(/\.[^/.]+$/, "").replace(/\[대본\]/g, "").trim() : project.name;
    const updatedProj: PodcastProject = {
      ...project,
      name: cleanName || project.name || '새 에피소드',
      script: rawText,
      segments: segments.length > 0 ? segments : project.segments,
      createdAt: project.createdAt || now,
      updatedAt: now
    };
    setProject(updatedProj);
    
    // 일주일(7일) 동안의 히스토리를 유지하며 새로 업로드된 프로젝트 반영
    setHistory(prev => {
      const validPrev = prev.filter(p => p.id !== updatedProj.id && isWithin7Days(p));
      const updated = [updatedProj, ...validPrev];
      localStorage.setItem('podcast_history', JSON.stringify(updated));
      return updated;
    });
    
    setBatchProjectIds([]);
    setBatchNotification(`대본이 로드되었습니다 (${segments.length}개 세그먼트)`);
    setTimeout(() => setBatchNotification(null), 4000);
  };

  // 1개 또는 2개 이상의 텍스트 파일을 드래그/선택하여 가져오는 함수
  const handleMultipleFiles = async (files: FileList | File[]) => {
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    if (!files || files.length === 0) return;
    
    // 파일 확장자 및 타입 필터링
    let fileArray = Array.from(files).filter(f => {
      const name = (f.name || '').toLowerCase();
      return name.endsWith('.txt') || name.endsWith('.text') || name.endsWith('.md') || 
             name.endsWith('.srt') || name.endsWith('.vtt') || name.endsWith('.csv') || 
             (f.type && f.type.startsWith('text/')) || !f.type;
    });
    if (fileArray.length === 0) {
      fileArray = Array.from(files);
    }
    if (fileArray.length === 0) return;

    isProcessingFilesRef.current = true;
    try {
      // 모든 파일 내용 비동기 읽기
      const fileContents = await Promise.all(
        fileArray.map(file => {
          return new Promise<{ name: string; text: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
              const rawText = (e.target?.result as string) || '';
              const cleanName = (file.name || '새 에피소드').replace(/\.[^/.]+$/, "").replace(/\[대본\]/g, "").trim() || '새 에피소드';
              resolve({ name: cleanName, text: rawText });
            };
            reader.onerror = () => {
              resolve({ name: file.name || '새 에피소드', text: '' });
            };
            reader.readAsText(file);
          });
        })
      );

      const validContents = fileContents.filter(fc => fc.text.trim().length > 0);
      if (validContents.length === 0) return;

      if (validContents.length === 1) {
        const { name, text } = validContents[0];
        handleRawTextDrop(text, name);
        return;
      }

      // 2개 이상의 파일인 경우: 각 파일별로 독립된 프로젝트(에피소드) 생성
      const now = Date.now();
      const newProjects: PodcastProject[] = validContents.map((fc, idx) => {
        const segments = parseScriptToSegments(fc.text);
        return {
          id: Math.random().toString(36).substr(2, 9),
          name: fc.name,
          voiceName: project.voiceName || defaultMaleVoice,
          segments,
          script: fc.text,
          createdAt: now + idx,
          updatedAt: now + idx
        };
      });

      // 1번째 프로젝트를 현재 활성 작업 화면으로 설정
      setProject(newProjects[0]);
      localStorage.setItem('podcast_current_project', JSON.stringify(newProjects[0]));

      // 일주일(7일) 동안의 히스토리를 보존하며 새로 업로드된 파일 프로젝트들 추가
      setHistory(prev => {
        const newIds = new Set(newProjects.map(np => np.id));
        const validPrev = prev.filter(p => !newIds.has(p.id) && isWithin7Days(p));
        const updated = [...newProjects, ...validPrev];
        localStorage.setItem('podcast_history', JSON.stringify(updated));
        return updated;
      });

      const batchIds = newProjects.map(p => p.id);
      setBatchProjectIds(batchIds);
      setBatchNotification(`📁 ${newProjects.length}개 파일이 로드되었습니다. 상단에서 각 파일의 성우와 제목을 개별 설정하고 [일괄 생성]할 수 있습니다.`);
      setTimeout(() => setBatchNotification(null), 6000);
    } catch (err) {
      console.error('File drop error:', err);
    } finally {
      isProcessingFilesRef.current = false;
    }
  };

  const previewVoiceFor = async (targetVoiceName: string) => {
    if (isPlayingPreview) { 
      previewAudioRef.current?.pause(); 
      setIsPlayingPreview(false); 
      return; 
    }
    setIsPlayingPreview(true);
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: "안녕하세요, 만나서 반갑습니다.",
          voiceName: targetVoiceName,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `미리듣기 생성 실패 (HTTP ${response.status})`);
      }

      const { audioData } = await response.json();
      if (!audioData) throw new Error("No audio data received");

      const decodedBytes = decodeBase64(audioData);
      let pcmBuffer = decodedBytes.buffer;
      if (
        decodedBytes.length > 44 &&
        decodedBytes[0] === 0x52 &&
        decodedBytes[1] === 0x49 &&
        decodedBytes[2] === 0x46 &&
        decodedBytes[3] === 0x46
      ) {
        pcmBuffer = decodedBytes.buffer.slice(44);
      }

      const rawSamples = new Int16Array(pcmBuffer);
      const normalizedSamples = normalizeInt16Samples(rawSamples, 0.95);
      const wavBlob = encodeWAV(normalizedSamples, 24000);
      const audioUrl = URL.createObjectURL(wavBlob);
      if (previewAudioRef.current) { 
        previewAudioRef.current.src = audioUrl; 
        previewAudioRef.current.play(); 
        previewAudioRef.current.onended = () => setIsPlayingPreview(false); 
      } else { 
        const audio = new Audio(audioUrl); 
        previewAudioRef.current = audio; 
        audio.play(); 
        audio.onended = () => setIsPlayingPreview(false); 
      }
    } catch (err) { 
      setIsPlayingPreview(false); 
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      alert(errorMessage);
    }
  };

  const previewVoice = () => {
    previewVoiceFor(project.voiceName);
  };

  const switchActiveProject = async (targetId: string) => {
    if (project.id === targetId) return;
    stopAudio();
    
    // 현재 프로젝트 히스토리에 동기화 (기존 배열 순서 유지)
    const currentSnapshot = { ...project, updatedAt: Date.now() };
    const hasCurrent = history.some(p => p.id === currentSnapshot.id);
    const updatedHistory = hasCurrent 
      ? history.map(p => p.id === currentSnapshot.id ? currentSnapshot : p)
      : [currentSnapshot, ...history];
      
    setHistory(updatedHistory);
    localStorage.setItem('podcast_history', JSON.stringify(updatedHistory));

    const target = updatedHistory.find(p => p.id === targetId);
    if (target) {
      const restored = await restoreProjectAudio(target);
      setProject(restored);
      localStorage.setItem('podcast_current_project', JSON.stringify(restored));
    }
  };

  const updateProjectNameInBatch = (id: string, newName: string) => {
    if (project.id === id) {
      setProject(prev => ({ ...prev, name: newName }));
    }
    setHistory(prev => {
      const updated = prev.map(p => p.id === id ? { ...p, name: newName } : p);
      localStorage.setItem('podcast_history', JSON.stringify(updated));
      return updated;
    });
  };

  const updateProjectVoiceInBatch = (id: string, newVoiceName: string) => {
    if (project.id === id) {
      setProject(prev => ({ ...prev, voiceName: newVoiceName }));
    }
    setHistory(prev => {
      const updated = prev.map(p => p.id === id ? { ...p, voiceName: newVoiceName } : p);
      localStorage.setItem('podcast_history', JSON.stringify(updated));
      return updated;
    });
  };

  const generateSingleProjectInBatch = async (targetId: string) => {
    const allProjectsMap = new Map<string, PodcastProject>();
    if (projectRef.current.id) allProjectsMap.set(projectRef.current.id, projectRef.current);
    historyRef.current.forEach(p => allProjectsMap.set(p.id, p));

    const target = allProjectsMap.get(targetId);
    if (!target) return;

    // 💡 기존 오디오가 이미 완료된 세그먼트는 제외하고 미완료 세그먼트만 필터링
    const segs = target.segments.filter(
      s => s.text.trim().length > 0 && !s.isGenerating && !(s.hasAudio || !!s.audioUrl)
    );

    if (segs.length === 0) {
      setBatchNotification(`'${target.name || "선택된 에피소드"}'의 모든 세그먼트 오디오 생성이 이미 완료되어 있습니다.`);
      setTimeout(() => setBatchNotification(null), 3000);
      return;
    }

    abortAllRef.current = false;
    const CONCURRENCY = 2;
    let currentIndex = 0;
    const worker = async () => {
      while (currentIndex < segs.length && !abortAllRef.current) {
        const itemIndex = currentIndex++;
        if (itemIndex >= segs.length) break;
        const s = segs[itemIndex];
        await generateSegmentAudio(target.id, s.id, s.text, s.seed, target.voiceName);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, () => worker()));

    // 모든 세그먼트 생성 후, 완료되면 생성 실패한 세그먼트만 순차적으로 한번더 다시 생성
    if (!abortAllRef.current) {
      const freshTarget = projectRef.current.id === targetId 
        ? projectRef.current 
        : historyRef.current.find(p => p.id === targetId);

      if (freshTarget) {
        const failedSegs = freshTarget.segments.filter(s => s.text.trim().length > 0 && (!s.audioUrl && !s.hasAudio || !!s.error));
        if (failedSegs.length > 0 && !abortAllRef.current) {
          setBatchNotification(`⚠️ 완료 후 실패한 ${failedSegs.length}개 세그먼트를 순차적으로 1회 다시 생성합니다...`);
          for (let i = 0; i < failedSegs.length; i++) {
            if (abortAllRef.current) break;
            const fs = failedSegs[i];
            setBatchNotification(`🔄 실패 세그먼트 순차 재시도 중 (${i + 1}/${failedSegs.length})...`);
            await generateSegmentAudio(target.id, fs.id, fs.text, fs.seed, target.voiceName);
            if (!abortAllRef.current && i < failedSegs.length - 1) {
              await new Promise(r => setTimeout(r, 1500));
            }
          }
          setBatchNotification(`🎉 순차 재시도가 완료되었습니다.`);
          setTimeout(() => setBatchNotification(null), 5000);
        }
      }
    }
  };

  const playAudio = async (segmentId: string, offset = 0) => {
    const segment = project.segments.find(s => s.id === segmentId);
    if (!segment) return;
    const blob = await getSegmentAudioBlob(project.id, segment);
    if (!blob) return;
    stopAudio(); setPlayingSegmentId(segmentId); offsetRef.current = offset;
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    const audioBuffer = await audioContextRef.current.decodeAudioData(await blob.arrayBuffer());
    setPlaybackProgress({ currentTime: offset, duration: audioBuffer.duration });
    const source = audioContextRef.current.createBufferSource();
    const gainNode = audioContextRef.current.createGain();
    source.buffer = audioBuffer; gainNode.gain.value = segment.volume ?? 1.0;
    source.connect(gainNode); gainNode.connect(audioContextRef.current.destination);
    source.onended = () => { if (offsetRef.current + (audioContextRef.current?.currentTime || 0) - startTimeRef.current >= audioBuffer.duration) stopAudio(); };
    sourceNodeRef.current = source; startTimeRef.current = audioContextRef.current.currentTime;
    source.start(0, offset); animationFrameRef.current = requestAnimationFrame(updatePlaybackProgress);
  };

  const normalizeVolumes = async () => {
    const audioSegments = project.segments.filter(s => s.audioUrl || s.hasAudio);
    if (audioSegments.length === 0) return;
    setIsExporting(true);
    try {
      const tempCtx = new AudioContext({ sampleRate: 24000 });
      const segmentPeaks: { id: string, peak: number }[] = [];
      for (const s of audioSegments) {
        const blob = await getSegmentAudioBlob(project.id, s);
        if (!blob) continue;
        const audioBuffer = await tempCtx.decodeAudioData(await blob.arrayBuffer());
        const channelData = audioBuffer.getChannelData(0);
        let max = 0; for (let i = 0; i < channelData.length; i++) { const abs = Math.abs(channelData[i]); if (abs > max) max = abs; }
        segmentPeaks.push({ id: s.id, peak: max });
      }
      const targetPeak = 0.8;
      setProject(prev => ({ ...prev, segments: prev.segments.map(s => { const peakInfo = segmentPeaks.find(p => p.id === s.id); return (peakInfo && peakInfo.peak > 0) ? { ...s, volume: targetPeak / peakInfo.peak } : s; }) }));
      await tempCtx.close();
    } catch (e) {} finally { setIsExporting(false); }
  };

  const performExportFullAudioForProject = async (targetProj: PodcastProject, shouldNormalize: boolean = false) => {
    setIsExporting(true); 
    setExportError(null);
    try {
      if (shouldNormalize) await normalizeVolumes();
      const audioSegments = targetProj.segments.filter(s => s.audioUrl || s.hasAudio);
      if (audioSegments.length === 0) {
        alert("생성된 오디오가 없습니다.");
        return;
      }
      const tempCtx = new AudioContext({ sampleRate: 24000 });
      const buffers = await Promise.all(audioSegments.map(async s => {
        const blob = await getSegmentAudioBlob(targetProj.id, s);
        if (!blob) throw new Error("Missing audio blob");
        return await tempCtx.decodeAudioData(await blob.arrayBuffer());
      }));
      const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
      const offlineCtx = new OfflineAudioContext(1, totalLength, 24000);
      let currentOffset = 0;
      for (let i = 0; i < buffers.length; i++) {
        const source = offlineCtx.createBufferSource(); 
        const gain = offlineCtx.createGain();
        source.buffer = buffers[i]; 
        gain.gain.value = audioSegments[i].volume ?? 1.0;
        source.connect(gain); 
        gain.connect(offlineCtx.destination);
        source.start(currentOffset); 
        currentOffset += buffers[i].duration;
      }
      const rendered = await offlineCtx.startRendering();
      const channelData = rendered.getChannelData(0);
      const samples = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) { 
        const s = Math.max(-1, Math.min(1, channelData[i])); 
        samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; 
      }
      const url = URL.createObjectURL(encodeWAV(samples, 24000));
      const a = document.createElement('a'); 
      const safeProjectName = formatAudioBaseName(targetProj.name);
      a.href = url; 
      a.download = `${safeProjectName}_combined.wav`; 
      a.click();
    } catch (e) { 
      console.error(e); 
      setExportError("내보내기 실패"); 
    } finally { 
      setIsExporting(false); 
    }
  };

  const performExportIndividualAudioForProject = async (targetProj: PodcastProject, shouldNormalize: boolean = false) => {
    setIsExporting(true);
    try {
      if (shouldNormalize) await normalizeVolumes();
      const zip = new JSZip();
      let count = 0;
      const baseName = formatAudioBaseName(targetProj.name);
      for (let i = 0; i < targetProj.segments.length; i++) {
        const seg = targetProj.segments[i];
        if (seg.audioUrl || seg.hasAudio) {
          const blob = await getSegmentAudioBlob(targetProj.id, seg);
          if (blob) {
            const segNum = String(i).padStart(2, '0');
            zip.file(`${baseName} segment_${segNum}.wav`, blob);
            count++;
          }
        }
      }
      if (count === 0) {
        alert("생성된 오디오가 없습니다.");
        return;
      }
      const content = await zip.generateAsync({ type: "blob" });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(content);
      a.download = `${baseName}.zip`;
      a.click();
    } catch (e) { 
      console.error(e); 
    } finally { 
      setIsExporting(false); 
    }
  };

  const downloadSingleSegmentAudio = async (segment: PodcastSegment, index: number) => {
    const blob = await getSegmentAudioBlob(project.id, segment);
    if (!blob) return;
    const baseName = formatAudioBaseName(project.name);
    const segNum = String(index).padStart(2, '0');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName} segment_${segNum}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const performExportFullAudio = (shouldNormalize: boolean) => {
    performExportFullAudioForProject(project, shouldNormalize);
  };

  const performExportIndividualAudio = (shouldNormalize: boolean) => {
    performExportIndividualAudioForProject(project, shouldNormalize);
  };

  const performExportBatchAllZips = async () => {
    if (batchProjects.length === 0) return;
    setIsExporting(true);
    try {
      const zip = new JSZip();
      let totalFiles = 0;
      for (const p of batchProjects) {
        const baseName = formatAudioBaseName(p.name || `episode_${p.id}`);
        const folder = zip.folder(baseName);
        if (!folder) continue;
        for (let i = 0; i < p.segments.length; i++) {
          const seg = p.segments[i];
          if (seg.audioUrl || seg.hasAudio) {
            const blob = await getSegmentAudioBlob(p.id, seg);
            if (blob) {
              const segNum = String(i).padStart(2, '0');
              folder.file(`${baseName} segment_${segNum}.wav`, blob);
              totalFiles++;
            }
          }
        }
      }
      if (totalFiles === 0) {
        alert("생성된 오디오가 없습니다.");
        return;
      }
      const content = await zip.generateAsync({ type: "blob" });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(content);
      a.download = `podcast_batch_all_${Date.now()}.zip`;
      a.click();
    } catch (e) {
      console.error(e);
    } finally {
      setIsExporting(false);
    }
  };

  // 단일 프로젝트 통합 내보내기 검사 및 실행
  const handleSingleExportFull = () => {
    if (completedSegmentsCount === 0) {
      alert("생성된 오디오가 없습니다. 먼저 오디오 생성을 진행해 주세요.");
      return;
    }
    if (completedSegmentsCount < totalSegmentsWithText) {
      setShowCountAlertModal({
        show: true,
        source: 'export_full',
        totalSegmentsCount: totalSegmentsWithText,
        completedSegmentsCount: completedSegmentsCount,
        titleName: project.name || '현재 에피소드'
      });
    } else {
      performExportFullAudio(false);
    }
  };

  // 단일 프로젝트 개별 내보내기 검사 및 실행
  const handleSingleExportIndividual = () => {
    if (completedSegmentsCount === 0) {
      alert("생성된 오디오가 없습니다. 먼저 오디오 생성을 진행해 주세요.");
      return;
    }
    if (completedSegmentsCount < totalSegmentsWithText) {
      setShowCountAlertModal({
        show: true,
        source: 'export_individual',
        totalSegmentsCount: totalSegmentsWithText,
        completedSegmentsCount: completedSegmentsCount,
        titleName: project.name || '현재 에피소드'
      });
    } else {
      performExportIndividualAudio(false);
    }
  };

  // 일괄 모드: 특정 에피소드 통합 내보내기 검사 및 실행
  const handleBatchItemExportFull = (p: PodcastProject) => {
    const pSegmentsWithText = p.segments.filter(s => s.text.trim());
    const pTotal = pSegmentsWithText.length;
    const pCompleted = p.segments.filter(s => s.text.trim() && (!!s.audioUrl || s.hasAudio)).length;
    if (pCompleted === 0) {
      alert("생성된 오디오가 없습니다. 먼저 오디오 생성을 진행해 주세요.");
      return;
    }
    if (pCompleted < pTotal) {
      setShowCountAlertModal({
        show: true,
        source: 'batch_item_full',
        targetProject: p,
        totalSegmentsCount: pTotal,
        completedSegmentsCount: pCompleted,
        titleName: p.name || '선택한 에피소드'
      });
    } else {
      performExportFullAudioForProject(p, false);
    }
  };

  // 일괄 모드: 특정 에피소드 개별 내보내기 검사 및 실행
  const handleBatchItemExportIndividual = (p: PodcastProject) => {
    const pSegmentsWithText = p.segments.filter(s => s.text.trim());
    const pTotal = pSegmentsWithText.length;
    const pCompleted = p.segments.filter(s => s.text.trim() && (!!s.audioUrl || s.hasAudio)).length;
    if (pCompleted === 0) {
      alert("생성된 오디오가 없습니다. 먼저 오디오 생성을 진행해 주세요.");
      return;
    }
    if (pCompleted < pTotal) {
      setShowCountAlertModal({
        show: true,
        source: 'batch_item_individual',
        targetProject: p,
        totalSegmentsCount: pTotal,
        completedSegmentsCount: pCompleted,
        titleName: p.name || '선택한 에피소드'
      });
    } else {
      performExportIndividualAudioForProject(p, false);
    }
  };

  // 일괄 모드: 전체 ZIP 일괄 다운로드 검사 및 실행
  const handleBatchAllZipsExport = () => {
    if (completedBatchSegmentsCount === 0) {
      alert("생성된 오디오가 없습니다. 먼저 오디오 생성을 진행해 주세요.");
      return;
    }
    if (completedBatchSegmentsCount < totalBatchSegmentsWithText) {
      setShowCountAlertModal({
        show: true,
        source: 'batch_all_zips',
        totalSegmentsCount: totalBatchSegmentsWithText,
        completedSegmentsCount: completedBatchSegmentsCount
      });
    } else {
      performExportBatchAllZips();
    }
  };

  const scrollToTop = () => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  const scrollToBottom = () => mainRef.current?.scrollTo({ top: mainRef.current.scrollHeight, behavior: 'smooth' });
  const handleTextFileDrop = (e: React.DragEvent, callback: (text: string, fileName?: string) => void) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    
    // 1. 파일이 드래그 앤 드롭된 경우
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = (event.target?.result as string) || '';
        if (text) callback(text, file.name);
      };
      reader.readAsText(file);
      return;
    }
    
    // 2. 텍스트를 직접 드래그 앤 드롭한 경우
    const plainText = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
    if (plainText) {
      callback(plainText);
    }
  };

  return (
    <div className="fixed inset-0 bg-white dark:bg-zinc-950 flex overflow-hidden">
      <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 flex flex-col bg-zinc-50 dark:bg-zinc-900/50">
        <div className="p-6 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 text-indigo-600 mb-6"><Mic2 size={24} /><span className="font-bold text-lg">educh 2.5 AI Studio</span></div>
          <button onClick={() => setProject({ id: Math.random().toString(36).substr(2, 9), name: '', voiceName: defaultMaleVoice, segments: [{ id: '1', text: '', seed: 791120 }], script: '', createdAt: Date.now(), updatedAt: Date.now() })} className="w-full py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2"><Plus size={16} /> 새 프로젝트</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center justify-between px-2 mb-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider">
              <History size={14} /> 
              <span>히스토리</span>
              <span className="text-[10px] font-normal lowercase bg-zinc-200/70 dark:bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">7일 보관</span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={exportHistory} title="히스토리 백업 내보내기" className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded text-zinc-400"><Upload size={14} /></button>
              <button onClick={() => historyInputRef.current?.click()} title="히스토리 복원 가져오기" className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded text-zinc-400"><Download size={14} /></button>
              <input type="file" ref={historyInputRef} className="hidden" accept=".json" onChange={importHistory} />
            </div>
          </div>
          {history.length === 0 ? (
            <div className="text-center py-8 text-xs text-zinc-400 leading-relaxed px-4">
              저장된 히스토리가 없습니다.<br />
              (업로드 및 작업한 프로젝트는 7일간 안전하게 보관됩니다)
            </div>
          ) : (
            history.map(p => {
              const hasError = p.segments.some(s => s.error);
              const pSegmentsWithText = p.segments.filter(s => s.text.trim());
              const pTotalSegmentsWithText = pSegmentsWithText.length;
              const pAggregateProgress = pTotalSegmentsWithText > 0 
                ? Math.floor(pSegmentsWithText.reduce((acc, s) => acc + (s.progress || 0), 0) / pTotalSegmentsWithText)
                : 0;
              const isComplete = pAggregateProgress === 100;
              const displayTime = p.updatedAt || p.createdAt;
              const isWithin24Hours = displayTime && (Date.now() - displayTime < 86400000);
              const dateStr = displayTime 
                ? `${new Date(displayTime).getMonth() + 1}/${new Date(displayTime).getDate()} ${String(new Date(displayTime).getHours()).padStart(2, '0')}:${String(new Date(displayTime).getMinutes()).padStart(2, '0')}`
                : '날짜 없음';

              return (
                <div key={p.id} className="group relative">
                  <button onClick={() => loadFromHistory(p)} className={`w-full text-left p-2.5 rounded-xl flex items-center justify-between transition-all ${project.id === p.id ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 font-medium' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60 text-zinc-700 dark:text-zinc-300'}`}>
                    <div className="truncate flex flex-col pr-6 min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isComplete && <span className="px-1 py-0.5 bg-green-50 text-green-600 text-[9px] font-medium rounded border border-green-100 flex-shrink-0 leading-none">완료</span>}
                        {hasError && <AlertCircle size={11} className="text-red-500 fill-red-50 flex-shrink-0" title="생성 중 오류 발생" />}
                        <span className="truncate text-[11px] font-normal leading-tight">{p.name || '제목 없는 에피소드'}</span>
                      </div>
                      <span className={`text-[10px] flex items-center gap-1 mt-0.5 ${isWithin24Hours ? 'text-indigo-500 dark:text-indigo-400 font-medium' : 'opacity-60'}`}>
                        <Clock size={10} /> 
                        {`${p.voiceName} (${p.segments.reduce((acc, s) => acc + (s.audioUrl || s.hasAudio ? s.text.length : 0), 0).toLocaleString()}자) | ${dateStr}`}
                      </span>
                    </div>
                    <ChevronRight size={14} className="opacity-40 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </button>
                  <button onClick={(e) => removeFromHistory(e, p.id)} title="히스토리에서 삭제" className="absolute right-8 top-1/2 -translate-y-1/2 p-1.5 text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 size={14} /></button>
                </div>
              );
            })
          )}
        </div>
        
        {/* 하단 오디오 캐시 전체 비우기 버튼 및 3일 자동 정리 안내 */}
        <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 space-y-1.5">
          <button 
            onClick={() => setShowClearAudioModal(true)}
            title="오늘 등록한 히스토리를 제외한 이전 작업의 모든 캐시, 메모리, 오디오 파일 및 이전 히스토리를 삭제합니다"
            className="w-full py-2 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-red-200 dark:hover:border-red-900/50 flex items-center justify-center gap-1.5 transition-all shadow-sm group cursor-pointer"
          >
            <Trash2 size={13} className="text-zinc-400 group-hover:text-red-500 transition-colors" />
            <span>오디오 캐시 전체 비우기</span>
          </button>
          <div className="flex items-center justify-center gap-1.5 text-[10.5px] text-zinc-400 dark:text-zinc-500 text-center">
            <Clock size={11} className="flex-shrink-0 text-amber-500/80" />
            <span>오디오 캐시는 3일 경과 시 자동 삭제</span>
          </div>
        </div>
      </aside>

      <div 
        className="flex-1 flex flex-col overflow-hidden relative"
        onDragEnter={(e) => {
          e.preventDefault();
          dragCounterRef.current++;
          setIsDraggingOver(true);
        }}
        onDragOver={(e) => { 
          e.preventDefault(); 
          if (!isDraggingOver) setIsDraggingOver(true);
        }}
        onDragLeave={(e) => { 
          e.preventDefault();
          dragCounterRef.current--;
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDraggingOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragCounterRef.current = 0;
          setIsDraggingOver(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleMultipleFiles(e.dataTransfer.files);
          } else {
            const rawText = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
            if (rawText) {
              handleRawTextDrop(rawText);
            }
          }
        }}
      >
        {/* 드래그 오버 피드백 오버레이 */}
        {isDraggingOver && (
          <div 
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragCounterRef.current = 0;
              setIsDraggingOver(false);
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleMultipleFiles(e.dataTransfer.files);
              } else {
                const rawText = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
                if (rawText) {
                  handleRawTextDrop(rawText);
                }
              }
            }}
            className="absolute inset-0 z-50 bg-indigo-500/10 backdrop-blur-sm border-2 border-dashed border-indigo-500 rounded-2xl m-4 flex flex-col items-center justify-center transition-all cursor-copy"
          >
            <div className="bg-white dark:bg-zinc-900 p-6 rounded-2xl shadow-xl border border-indigo-200 dark:border-indigo-800 flex flex-col items-center gap-3 pointer-events-none">
              <div className="p-3 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 rounded-full animate-bounce">
                <Files size={32} />
              </div>
              <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">여기에 대본 파일(.txt)을 놓으세요</p>
              <p className="text-xs text-zinc-400">여러 개(2개 이상)의 파일을 동시에 가져오면 일괄 생성이 활성화됩니다</p>
            </div>
          </div>
        )}

        {isBatchMode ? (
          <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md z-10 p-4 space-y-3 shadow-xs">
            <div className="max-w-5xl mx-auto w-full flex flex-col gap-3">
              {/* 상단 일괄 모드 상태 & 마스터 컨트롤 바 */}
              <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800/80">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 rounded-lg">
                    <Files size={16} />
                  </div>
                  <div>
                    <h2 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                      다중 에피소드 일괄 작업 모드
                      <span className="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 rounded-full text-[10px] font-extrabold">
                        {batchProjects.length}개 파일 로드됨
                      </span>
                    </h2>
                    <p className="text-[10px] text-zinc-400">각 에피소드의 제목, 성우, 다운로드를 개별 설정하거나 우측 버튼으로 전체 일괄 생성할 수 있습니다.</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* 마스터 일괄 생성 버튼 */}
                  <button
                    onClick={() => {
                      if (isGeneratingAll) {
                        stopAllGeneration();
                      } else {
                        const non12 = batchProjects.filter(p => p.segments.length !== 12);
                        if (non12.length > 0) {
                          setShowCountAlertModal({
                            show: true,
                            source: 'batch_all',
                            non12Projects: non12.map((p, idx) => ({
                              id: p.id,
                              name: p.name || `에피소드 ${idx + 1}`,
                              count: p.segments.length
                            }))
                          });
                        } else {
                          generateBatchProjects(batchProjectIds);
                        }
                      }
                    }}
                    disabled={isExporting}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm ${
                      isGeneratingAll
                        ? 'bg-red-500 text-white hover:bg-red-600 animate-pulse'
                        : isAllBatchCompleted
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    {isGeneratingAll ? <Square size={14} fill="currentColor" /> : <Sparkles size={14} />}
                    <span>
                      {isGeneratingAll
                        ? `일괄 생성 중지 (${totalBatchSegmentsWithText}(${completedBatchSegmentsCount}))`
                        : `전체 일괄 생성 (${batchProjects.length}개 파일)`}
                    </span>
                  </button>

                  {/* 전체 ZIP 일괄 다운로드 */}
                  <button
                    onClick={handleBatchAllZipsExport}
                    disabled={isExporting || completedBatchSegmentsCount === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 disabled:opacity-40 rounded-xl text-xs font-bold text-zinc-700 dark:text-zinc-200 transition-all"
                    title="모든 에피소드를 하나의 ZIP 파일로 다운로드"
                  >
                    <Download size={14} />
                    <span>전체 ZIP 다운로드</span>
                  </button>

                  {/* 일괄 모드 닫기 */}
                  <button
                    onClick={() => {
                      setBatchProjectIds([]);
                      setBatchNotification(null);
                    }}
                    className="p-1.5 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg text-xs"
                    title="일괄 모드 닫기 (현재 선택된 에피소드만 계속 작업)"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* 위 아래로 고정 표시되는 에피소드 1, 2 컨트롤 패널 (위치 불변, 색상으로만 선택 상태 표시) */}
              <div className="flex flex-col gap-2.5">
                {batchProjects.map((p, idx) => {
                  const isActive = project.id === p.id;
                  const pSegmentsWithText = p.segments.filter(s => s.text.trim());
                  const pTotal = pSegmentsWithText.length;
                  const pCompleted = p.segments.filter(s => s.text.trim() && (s.audioUrl || s.hasAudio)).length;
                  const pIsGenerating = p.segments.some(s => s.isGenerating);
                  const pIsComplete = pTotal > 0 && pCompleted === pTotal;

                  return (
                    <div
                      key={p.id}
                      className={`p-3 rounded-2xl border transition-all flex flex-wrap items-center justify-between gap-3 ${
                        isActive
                          ? 'bg-indigo-50/90 dark:bg-indigo-950/60 border-indigo-500 dark:border-indigo-400 shadow-md ring-2 ring-indigo-400/30 dark:ring-indigo-500/30'
                          : 'bg-white dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800/90 hover:border-zinc-300 dark:hover:border-zinc-700 opacity-85 hover:opacity-100 shadow-xs'
                      }`}
                    >
                      {/* 1. 에피소드 선택 뱃지 & 제목 입력 */}
                      <div className="flex items-center gap-2.5 flex-1 min-w-[280px]">
                        <button
                          onClick={() => switchActiveProject(p.id)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition-all flex items-center gap-1.5 flex-shrink-0 cursor-pointer ${
                            isActive
                              ? 'bg-indigo-600 text-white shadow-sm ring-2 ring-indigo-200 dark:ring-indigo-900 scale-100'
                              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/70 hover:text-indigo-700 dark:hover:text-indigo-200'
                          }`}
                          title="클릭 시 이 에피소드를 하단 편집기에서 수정할 수 있도록 선택합니다"
                        >
                          <span className="font-black">#{idx + 1}</span>
                          <span>{isActive ? '편집 중' : '선택'}</span>
                        </button>

                        <div className={`flex items-center gap-2 border px-3.5 py-1.5 rounded-xl flex-1 transition-all ${
                          isActive 
                            ? 'bg-white dark:bg-zinc-900 border-indigo-300 dark:border-indigo-700 shadow-xs' 
                            : 'bg-zinc-50 dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-700/80'
                        }`}>
                          <input
                            value={p.name}
                            onChange={(e) => updateProjectNameInBatch(p.id, e.target.value)}
                            className="bg-transparent font-bold text-xs sm:text-sm outline-none w-full text-zinc-900 dark:text-zinc-100"
                            placeholder={`에피소드 ${idx + 1} 제목 입력...`}
                          />
                          <Edit2 size={13} className={isActive ? "text-indigo-400" : "text-zinc-400"} />
                        </div>
                      </div>

                      {/* 2. 성우 선택 & 미리듣기 */}
                      <div className="flex items-center gap-2">
                        <div className={`flex items-center gap-1 p-1 rounded-xl border ${
                          isActive 
                            ? 'bg-white dark:bg-zinc-900 border-indigo-200 dark:border-indigo-800' 
                            : 'bg-zinc-100 dark:bg-zinc-800/80 border-transparent'
                        }`}>
                          <select
                            value={p.voiceName || defaultMaleVoice}
                            onChange={(e) => updateProjectVoiceInBatch(p.id, e.target.value)}
                            className="bg-transparent text-xs font-semibold outline-none px-2 py-0.5"
                          >
                            {voices.map(v => (
                              <option key={v.name} value={v.name}>
                                {v.name} ({v.gender === 'Male' ? '남' : '여'})
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => previewVoiceFor(p.voiceName || defaultMaleVoice)}
                            className="p-1 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 hover:bg-indigo-100"
                            title="성우 미리듣기"
                          >
                            <Play size={10} fill="currentColor" />
                          </button>
                        </div>

                        {/* 3. 개별 에피소드 생성 버튼 */}
                        <button
                          onClick={() => {
                            if (p.segments.length !== 12) {
                              setShowCountAlertModal({
                                show: true,
                                source: 'batch_single',
                                targetProjectId: p.id,
                                non12Projects: [{
                                  id: p.id,
                                  name: p.name || `에피소드 ${idx + 1}`,
                                  count: p.segments.length
                                }]
                              });
                            } else {
                              generateSingleProjectInBatch(p.id);
                            }
                          }}
                          disabled={isExporting}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all ${
                            pIsGenerating
                              ? 'bg-red-50 text-red-600 animate-pulse'
                              : pIsComplete
                                ? 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                                : 'bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300'
                          }`}
                          title="이 에피소드만 오디오 생성"
                        >
                          <Mic2 size={13} />
                          <span>
                            {pIsGenerating ? `생성 중 (${pTotal}(${pCompleted}))` : `생성 ${pTotal}(${pCompleted})`}
                          </span>
                        </button>

                        {/* 4. 개별 에피소드 다운로드 (통합 & 개별) */}
                        <button
                          onClick={() => handleBatchItemExportFull(p)}
                          disabled={isExporting || pCompleted === 0}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 disabled:opacity-30 rounded-xl text-xs font-bold text-zinc-700 dark:text-zinc-300 transition-all"
                          title="이 에피소드 전체 통합 WAV 다운로드"
                        >
                          <Download size={13} />
                          <span>통합</span>
                        </button>

                        <button
                          onClick={() => handleBatchItemExportIndividual(p)}
                          disabled={isExporting || pCompleted === 0}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 disabled:opacity-30 rounded-xl text-xs font-bold text-zinc-700 dark:text-zinc-300 transition-all"
                          title="이 에피소드 세그먼트별 ZIP 다운로드"
                        >
                          <FileArchive size={13} />
                          <span>개별</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <header className="h-16 border-b border-zinc-200 dark:border-zinc-800 flex items-center bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md z-10">
            <div className="max-w-5xl mx-auto w-full px-8 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-4 py-1.5 rounded-xl focus-within:border-indigo-500 transition-all shadow-sm">
                  <input 
                    value={project.name} 
                    onChange={(e) => setProject(p => ({ ...p, name: e.target.value }))} 
                    className="bg-transparent font-bold text-base outline-none w-64" 
                    placeholder="에피소드 제목 입력..."
                  />
                  <Edit2 size={14} className="text-zinc-400" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-900 p-1 rounded-full">
                  <select value={selectedGender} onChange={(e) => setSelectedGender(e.target.value)} className="bg-transparent text-xs outline-none px-2"><option value="All">모든 성별</option><option value="Male">남성</option><option value="Female">여성</option></select>
                  <select value={project.voiceName} onChange={(e) => setProject(p => ({ ...p, voiceName: e.target.value }))} className="bg-transparent text-xs outline-none px-2">{filteredVoices.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}</select>
                  <button onClick={previewVoice} className={`p-1.5 rounded-full ${isPlayingPreview ? 'bg-indigo-600 text-white animate-pulse' : 'bg-indigo-50 text-indigo-600'}`}>{isPlayingPreview ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}</button>
                </div>

                <button 
                  onClick={() => {
                    if (isGeneratingAll) {
                      stopAllGeneration();
                    } else {
                      if (project.segments.length !== 12) {
                        setShowCountAlertModal({ show: true, source: 'header' });
                        return;
                      }
                      generateAllAudio();
                    }
                  }} 
                  disabled={isExporting} 
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-all ${isGeneratingAll ? 'bg-red-50 text-red-600 hover:bg-red-100' : isAllCompleted ? 'bg-blue-50 text-blue-600 hover:bg-blue-100' : 'bg-zinc-100 dark:bg-zinc-900'}`}
                >
                  {isGeneratingAll ? <Square size={16} fill="currentColor" /> : <Mic2 size={16} />}
                  {isGeneratingAll ? `중지 (${totalSegments}(${completedSegmentsCount}))` : `생성 ${totalSegments}(${completedSegmentsCount})`}
                </button>

                <button 
                  onClick={handleSingleExportFull} 
                  disabled={isExporting} 
                  className="flex items-center gap-2 px-3 py-2 bg-zinc-100 dark:bg-zinc-900 rounded-xl text-xs font-bold"
                >
                  <Download size={16} />통합
                </button>
                <button 
                  onClick={handleSingleExportIndividual} 
                  disabled={isExporting} 
                  className="flex items-center gap-2 px-3 py-2 bg-zinc-100 dark:bg-zinc-900 rounded-xl text-xs font-bold"
                >
                  <FileArchive size={16} />개별
                </button>
                <button onClick={saveToHistory} className="p-2 bg-zinc-100 dark:bg-zinc-900 rounded-full"><Save size={18} /></button>
              </div>
            </div>
          </header>
        )}

        {/* 일괄 로드 알림 배너 */}
        {batchNotification && (
          <div className="bg-indigo-50 dark:bg-indigo-950/60 border-b border-indigo-100 dark:border-indigo-900/50 px-8 py-2.5 text-xs text-indigo-700 dark:text-indigo-300 flex items-center justify-between transition-all">
            <div className="flex items-center gap-2 font-medium">
              <Files size={14} className="flex-shrink-0" />
              <span>{batchNotification}</span>
            </div>
            <button onClick={() => setBatchNotification(null)} className="p-1 hover:bg-indigo-100 dark:hover:bg-indigo-900 rounded-full">
              <X size={12} />
            </button>
          </div>
        )}

        <main ref={mainRef} className="flex-1 overflow-y-auto p-8 space-y-8 max-w-5xl mx-auto w-full">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-wider">
                <FileText size={14} /> 에피소드 스크립트
              </div>
              <div className="flex items-center gap-2">
                <input 
                  type="file" 
                  multiple 
                  accept=".txt,.text" 
                  ref={multiFileInputRef} 
                  className="hidden" 
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleMultipleFiles(e.target.files);
                    }
                  }} 
                />
                <button 
                  onClick={() => multiFileInputRef.current?.click()} 
                  className="text-[10px] font-bold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 px-3 py-1.5 rounded-full flex items-center gap-1 transition-all"
                  title="텍스트 파일 단일 또는 복수(일괄) 선택"
                >
                  <Files size={12} /> 파일 가져오기
                </button>
                <button onClick={() => splitScriptToSegments('paragraph')} className="text-[10px] font-bold bg-zinc-100 px-3 py-1.5 rounded-full">단락별 분할</button>
                <button onClick={() => splitScriptToSegments('problem')} className="text-[10px] font-bold bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-full">문제별 분할</button>
              </div>
            </div>
            <div 
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounterRef.current = 0;
                setIsDraggingOver(false);
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  handleMultipleFiles(e.dataTransfer.files);
                } else {
                  const rawText = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
                  if (rawText) {
                    handleRawTextDrop(rawText);
                  }
                }
              }}
              className="bg-white dark:bg-zinc-900 p-6 rounded-3xl border border-zinc-300 dark:border-zinc-700 shadow-sm relative"
            >
              <textarea value={project.script} onChange={(e) => setProject(p => ({ ...p, script: e.target.value }))} className="w-full bg-transparent outline-none resize-none min-h-[120px] text-sm leading-relaxed" placeholder="전체 스크립트를 작성하거나 .txt 파일을 드래그하세요..." />
              <div className="absolute bottom-4 right-6 text-[10px] text-zinc-300">{project.script.length} / 8500 자</div>
            </div>
          </section>

          <section className="space-y-6">
            <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-wider"><Volume2 size={14} /> 오디오 세그먼트</div><div className="flex items-center gap-2"><button onClick={copyAllSegmentsText} className="text-[10px] font-bold bg-zinc-100 px-3 py-1.5 rounded-full">전체 복사</button><button onClick={() => setShowDeleteConfirm(!showDeleteConfirm)} className="text-[10px] font-bold bg-red-50 text-red-500 px-3 py-1.5 rounded-full">전체 삭제</button></div></div>
            <div className="space-y-4">
              {project.segments.map((s, i) => (
                <React.Fragment key={s.id}>
                  {i > 0 && (
                    <div className="flex justify-center -my-2 relative z-10 opacity-0 hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => insertSegment(i)}
                        className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 p-1 rounded-full shadow-sm text-zinc-400 hover:text-indigo-600 hover:scale-110 transition-all"
                        title="세그먼트 삽입"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  )}
                  <div 
                    id={`segment-${s.id}`}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      dragCounterRef.current = 0;
                      setIsDraggingOver(false);
                      if (e.dataTransfer.files && e.dataTransfer.files.length > 1) {
                        handleMultipleFiles(e.dataTransfer.files);
                      } else {
                        handleTextFileDrop(e, (text) => {
                          deleteAudioBlob(project.id, s.id);
                          setProject(p => ({ ...p, segments: p.segments.map(seg => seg.id === s.id ? { ...seg, text, audioUrl: undefined, hasAudio: false } : seg) }));
                        });
                      }
                    }}
                    className="bg-white dark:bg-zinc-900 p-5 rounded-3xl border border-zinc-300 dark:border-zinc-700 shadow-sm relative group scroll-mt-24"
                  >
                    <div className="flex justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black text-zinc-300 tracking-[0.2em]">세그먼트 {String(i).padStart(2, '0')}</span>
                        <span className="text-[10px] text-zinc-400 font-medium">{s.text.length} 자</span>
                        {s.retryCountdown !== undefined && s.retryCountdown > 0 ? (
                          <span className="px-2 py-0.5 bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 text-[10px] font-bold rounded-full border border-amber-300 dark:border-amber-800 flex items-center gap-1 animate-pulse">
                            <Clock size={10} className="animate-spin text-amber-600" /> 1분 후 재생성 ({s.retryCountdown}초)
                          </span>
                        ) : s.error ? (
                          <span className="px-1.5 py-0.5 bg-red-50 text-red-600 dark:bg-red-950/60 dark:text-red-400 text-[10px] font-semibold rounded border border-red-200 dark:border-red-900/60 flex items-center gap-1">
                            <AlertCircle size={10} /> {s.error.includes('할당량') ? '할당량 초과' : '생성 실패'}
                          </span>
                        ) : null}
                      </div>
                      <button onClick={() => removeSegment(s.id)} className="opacity-0 group-hover:opacity-100"><Trash2 size={16} className="text-zinc-400 hover:text-red-500" /></button>
                    </div>
                    <textarea 
                      value={s.text} 
                      onChange={(e) => {
                        deleteAudioBlob(project.id, s.id);
                        setProject(p => ({ ...p, segments: p.segments.map(seg => seg.id === s.id ? { ...seg, text: e.target.value, audioUrl: undefined, hasAudio: false } : seg) }));
                      }} 
                      className="w-full bg-transparent outline-none resize-none min-h-[100px] text-base" 
                      placeholder="텍스트를 입력하세요..." 
                    />
                    <div className="flex justify-between items-center mt-4 pt-4 border-t border-zinc-50 dark:border-zinc-800/50">
                      <div className="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded-full text-[10px] font-medium">
                        <Lock size={10} />시드: 
                        <input 
                          type="number" 
                          value={s.seed} 
                          onChange={(e) => {
                            deleteAudioBlob(project.id, s.id);
                            setProject(p => ({ ...p, segments: p.segments.map(seg => seg.id === s.id ? { ...seg, seed: parseInt(e.target.value) || 0, audioUrl: undefined, hasAudio: false } : seg) }));
                          }} 
                          className="bg-transparent w-16 outline-none" 
                        />
                        <button onClick={() => {
                          deleteAudioBlob(project.id, s.id);
                          setProject(p => ({ ...p, segments: p.segments.map(seg => seg.id === s.id ? { ...seg, seed: 791120, audioUrl: undefined, hasAudio: false } : seg) }));
                        }}>
                          <RefreshCw size={10} className="text-indigo-500" />
                        </button>
                      </div>
                      <div className="flex items-center gap-3">
                        {s.audioUrl ? (
                          <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 p-1 rounded-full pr-2">
                            <button onClick={() => playAudio(s.id)} className="w-10 h-10 bg-indigo-600 text-white rounded-full flex items-center justify-center hover:bg-indigo-700 transition-all">
                              <Play size={16} fill="currentColor" className="ml-0.5" />
                            </button>
                            <button 
                              onClick={stopAudio} 
                              disabled={playingSegmentId !== s.id}
                              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${playingSegmentId === s.id ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-zinc-100 text-zinc-300 cursor-not-allowed'}`}
                              title="정지"
                            >
                              <Square size={16} fill="currentColor" />
                            </button>
                            <div className="w-24 h-8"><AudioVisualizer isPlaying={playingSegmentId === s.id} /></div>
                            <button 
                              onClick={() => downloadSingleSegmentAudio(s, i)}
                              className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-indigo-600 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all"
                              title="이 세그먼트 WAV 다운로드"
                            >
                              <Download size={14} />
                            </button>
                          </div>
                        ) : s.retryCountdown !== undefined && s.retryCountdown > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-full text-xs font-bold animate-pulse">
                              <Clock size={14} className="text-amber-600 animate-spin" />
                              <span>할당량 대기 ({s.retryCountdown}초)</span>
                            </div>
                            <button 
                              onClick={() => stopGeneration(s.id)} 
                              className="w-10 h-10 bg-red-50 text-red-600 rounded-full flex items-center justify-center hover:bg-red-100 transition-all"
                              title="대기 취소"
                            >
                              <Square size={16} fill="currentColor" />
                            </button>
                          </div>
                        ) : s.isGenerating ? (
                          <div className="flex items-center gap-2">
                            {/* 생성 진행 중에는 기존처럼 로딩 스피너와 진행율(%)을 메인으로 표시 */}
                            <div className="flex items-center gap-3 px-4 py-2 bg-zinc-100 dark:bg-zinc-800 rounded-full">
                              <Loader2 size={16} className="animate-spin text-indigo-600" />
                              <span className="text-[10px] font-bold">{Math.round(s.progress || 0)}%</span>
                            </div>
                            <button 
                              onClick={() => stopGeneration(s.id)} 
                              className="w-10 h-10 bg-red-50 text-red-600 rounded-full flex items-center justify-center hover:bg-red-100 transition-all"
                              title="생성 중지"
                            >
                              <Square size={16} fill="currentColor" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            {s.error && (
                              <span className="text-[11px] text-red-500 bg-red-50 dark:bg-red-950/60 px-2.5 py-1 rounded-full border border-red-200 dark:border-red-900 max-w-[150px] truncate" title={s.error}>
                                {s.error.includes('429') ? '할당량 초과' : '오류 발생'}
                              </span>
                            )}
                            <button 
                              onClick={() => generateAudio(s.id)} 
                              disabled={!s.text.trim()} 
                              className={`px-6 py-2 text-white text-xs font-bold rounded-full transition-all ${
                                s.error 
                                  ? 'bg-red-600 hover:bg-red-700 shadow-sm' 
                                  : 'bg-zinc-900 dark:bg-indigo-600 hover:bg-zinc-800 dark:hover:bg-indigo-700'
                              }`}
                            >
                              {s.error ? '다시 생성' : '오디오 생성'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              ))}
            </div>
            <button onClick={addSegment} className="w-full py-6 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-3xl text-zinc-400 font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2"><Plus size={18} /> 새 세그먼트 추가</button>
          </section>
        </main>

        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4"><div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 max-w-md w-full shadow-2xl border border-zinc-200 dark:border-zinc-800"><h3 className="text-xl font-bold mb-4">전체 삭제</h3><p className="text-zinc-600 mb-8 leading-relaxed">모든 세그먼트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.</p><div className="flex flex-col gap-3"><button onClick={deleteAllSegments} className="w-full py-4 bg-red-600 text-white rounded-2xl font-bold">삭제하기</button><button onClick={() => setShowDeleteConfirm(false)} className="w-full py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-bold">취소</button></div></div></div>
        )}

        {/* 오디오 캐시 전체 비우기 확인 모달 */}
        {showClearAudioModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[110] p-4 text-center">
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 max-w-md w-full shadow-2xl border border-zinc-200 dark:border-zinc-800">
              <div className="flex justify-center mb-4 text-red-500">
                <div className="p-3 bg-red-50 dark:bg-red-950/50 rounded-full">
                  <Trash2 size={36} className="text-red-600" />
                </div>
              </div>
              <h3 className="text-xl font-bold mb-3 text-zinc-900 dark:text-zinc-100">오디오 캐시 및 이전 데이터 비우기</h3>
              <div className="text-zinc-600 dark:text-zinc-400 mb-6 text-xs sm:text-sm leading-relaxed text-left space-y-2.5 bg-zinc-50 dark:bg-zinc-800/60 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-700/60">
                <div className="flex items-center justify-between p-2.5 bg-emerald-50 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-900/50 text-emerald-800 dark:text-emerald-300 font-medium text-xs">
                  <span>✅ 오늘 등록된 히스토리 (보존)</span>
                  <span className="font-bold">{history.filter(isProjectRegisteredToday).length + (isProjectRegisteredToday(project) && !history.some(p => p.id === project.id) ? 1 : 0)}개 보존</span>
                </div>
                <div className="flex items-center justify-between p-2.5 bg-red-50 dark:bg-red-950/40 rounded-xl border border-red-200 dark:border-red-900/50 text-red-800 dark:text-red-300 font-medium text-xs">
                  <span>🗑️ 삭제 대상 이전 캐시·파일·히스토리</span>
                  <span className="font-bold">{history.filter(p => !isProjectRegisteredToday(p)).length + (!isProjectRegisteredToday(project) && (project.name || project.script || project.segments.some(s => s.text.trim())) ? 1 : 0)}개 삭제</span>
                </div>
                <p className="pt-1">
                  • <strong>오늘 등록한 히스토리와 오디오 파일</strong>은 안전하게 그대로 유지됩니다.
                </p>
                <p>
                  • 오늘 이전에 작업하여 브라우저에 남겨진 <strong>모든 캐시, 메모리, 오디오 파일(WAV), 이전 히스토리</strong>는 완전히 삭제됩니다.
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                <button 
                  onClick={handleClearAllAudioCache}
                  className="w-full py-3.5 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-bold transition-all shadow-sm cursor-pointer"
                >
                  오늘 등록 제외 모두 삭제
                </button>
                <button 
                  onClick={() => setShowClearAudioModal(false)}
                  className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-2xl font-semibold transition-all cursor-pointer"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        )}

        {showCountAlertModal.show && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[110] p-4 text-center">
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 max-w-md w-full shadow-2xl border border-zinc-200 dark:border-zinc-800">
              <div className="flex justify-center mb-4 text-amber-500">
                <AlertCircle size={48} />
              </div>
              <h3 className="text-xl font-bold mb-3">
                {['export_individual', 'export_full', 'batch_item_full', 'batch_item_individual', 'batch_all_zips'].includes(showCountAlertModal.source || '')
                  ? '오디오 생성 미완료 안내'
                  : '세그먼트 개수 확인'}
              </h3>
              <div className="text-zinc-600 dark:text-zinc-400 mb-6 text-sm leading-relaxed">
                {showCountAlertModal.source === 'export_individual' || showCountAlertModal.source === 'export_full' ? (
                  <>
                    {showCountAlertModal.titleName && (
                      <div className="mb-2 font-bold text-zinc-900 dark:text-zinc-100 text-base">
                        {showCountAlertModal.titleName}
                      </div>
                    )}
                    전체 세그먼트(<strong>{showCountAlertModal.totalSegmentsCount ?? totalSegmentsWithText}개</strong>) 중 생성 완료된 오디오는 <strong>{showCountAlertModal.completedSegmentsCount ?? completedSegmentsCount}개</strong>입니다.<br/>
                    오디오 생성이 완료되지 않은 세그먼트가 있습니다.<br/>
                    오디오가 누락된 상태로 <strong>{showCountAlertModal.source === 'export_full' ? '통합' : '개별'}</strong> 다운로드를 계속 진행하시겠습니까?
                  </>
                ) : showCountAlertModal.source === 'batch_item_full' || showCountAlertModal.source === 'batch_item_individual' ? (
                  <>
                    <div className="mb-2 font-bold text-zinc-900 dark:text-zinc-100 text-base">
                      {showCountAlertModal.titleName}
                    </div>
                    전체 세그먼트(<strong>{showCountAlertModal.totalSegmentsCount}개</strong>) 중 생성 완료된 오디오는 <strong>{showCountAlertModal.completedSegmentsCount}개</strong>입니다.<br/>
                    오디오 생성이 완료되지 않은 세그먼트가 있습니다.<br/>
                    오디오가 누락된 상태로 <strong>{showCountAlertModal.source === 'batch_item_full' ? '통합' : '개별'}</strong> 다운로드를 계속 진행하시겠습니까?
                  </>
                ) : showCountAlertModal.source === 'batch_all_zips' ? (
                  <>
                    전체 {batchProjects.length}개 에피소드(총 <strong>{showCountAlertModal.totalSegmentsCount}개</strong> 세그먼트) 중 생성 완료된 오디오는 <strong>{showCountAlertModal.completedSegmentsCount}개</strong>입니다.<br/>
                    일부 에피소드에 오디오 생성이 완료되지 않은 세그먼트가 포함되어 있습니다.<br/>
                    오디오가 누락된 상태로 <strong>전체 ZIP 일괄 다운로드</strong>를 계속 진행하시겠습니까?
                  </>
                ) : showCountAlertModal.source === 'batch_all' ? (
                  <>
                    각 에피소드는 <strong>정확히 12개</strong>의 세그먼트로 일치해야 합니다.<br/>
                    현재 12개와 일치하지 않는 에피소드가 있습니다:
                    <div className="my-3 py-2 px-3 bg-zinc-100 dark:bg-zinc-800 rounded-xl text-xs text-left max-h-36 overflow-y-auto space-y-1.5 border border-zinc-200 dark:border-zinc-700/70">
                      {showCountAlertModal.non12Projects?.map((item, idx) => (
                        <div key={item.id} className="flex justify-between items-center text-zinc-800 dark:text-zinc-200">
                          <span className="font-semibold truncate max-w-[210px]">{item.name || `에피소드 ${idx + 1}`}</span>
                          <span className="font-bold text-amber-600 dark:text-amber-400 flex-shrink-0">{item.count}개 / 권장 12개</span>
                        </div>
                      ))}
                    </div>
                    정확히 12개가 아니더라도 전체 일괄 생성을 계속 진행하시겠습니까?
                  </>
                ) : showCountAlertModal.source === 'batch_single' ? (
                  <>
                    각 에피소드는 <strong>정확히 12개</strong>의 세그먼트로 일치해야 합니다.<br/>
                    선택한 에피소드(<strong>{showCountAlertModal.non12Projects?.[0]?.name || '에피소드'}</strong>)의 세그먼트는 현재 <strong>{showCountAlertModal.non12Projects?.[0]?.count}개</strong>입니다.<br/>
                    그래도 생성을 계속 진행하시겠습니까?
                  </>
                ) : (
                  <>
                    각 에피소드는 <strong>정확히 12개</strong>의 세그먼트로 일치해야 합니다.<br/>
                    현재 세그먼트는 <strong>{project.segments.length}개</strong>입니다.<br/>
                    그래도 생성을 계속 진행하시겠습니까?
                  </>
                )}
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => {
                    const source = showCountAlertModal.source;
                    const targetId = showCountAlertModal.targetProjectId;
                    const targetProj = showCountAlertModal.targetProject;
                    setShowCountAlertModal({ show: false, source: null });
                    if (source === 'header') {
                      generateAllAudio();
                    } else if (source === 'batch_all') {
                      generateBatchProjects(batchProjectIds);
                    } else if (source === 'batch_single' && targetId) {
                      generateSingleProjectInBatch(targetId);
                    } else if (source === 'export_individual') {
                      performExportIndividualAudio(false);
                    } else if (source === 'export_full') {
                      performExportFullAudio(false);
                    } else if (source === 'batch_item_full' && targetProj) {
                      performExportFullAudioForProject(targetProj, false);
                    } else if (source === 'batch_item_individual' && targetProj) {
                      performExportIndividualAudioForProject(targetProj, false);
                    } else if (source === 'batch_all_zips') {
                      performExportBatchAllZips();
                    }
                  }} 
                  className="w-full py-3.5 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all cursor-pointer shadow-sm"
                >
                  {['export_individual', 'export_full', 'batch_item_full', 'batch_item_individual', 'batch_all_zips'].includes(showCountAlertModal.source || '')
                    ? '그대로 다운로드 진행'
                    : '계속 진행'}
                </button>
                <button 
                  onClick={() => setShowCountAlertModal({ show: false, source: null })} 
                  className="w-full py-3.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all cursor-pointer"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 실시간 진행중 세그먼트 플로팅 바 */}
        <AnimatePresence>
          {allGeneratingSegments.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 30, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 30, scale: 0.95 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-zinc-900/95 dark:bg-zinc-800/95 backdrop-blur-md text-white border border-zinc-700/80 shadow-2xl rounded-2xl px-4 py-2.5 flex items-center gap-3 max-w-[calc(100vw-4rem)] max-w-xl"
            >
              {/* 실시간 펄스 인디케이터 */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-500"></span>
                </span>
                <span className="text-xs font-bold text-zinc-100 flex items-center gap-1">
                  <span>생성 중</span>
                  <span className="text-indigo-400 font-mono text-[11px]">({allGeneratingSegments.length})</span>
                </span>
              </div>

              <div className="h-4 w-px bg-zinc-700/80 flex-shrink-0"></div>

              {/* 진행중인 세그먼트 번호 배지 리스트 */}
              <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 max-w-sm sm:max-w-md no-scrollbar">
                {allGeneratingSegments.map(item => {
                  const isWaiting = item.retryCountdown !== undefined && item.retryCountdown > 0;
                  return (
                    <button
                      key={`${item.projectId}_${item.id}`}
                      onClick={() => {
                        if (item.projectId === project.id) {
                          scrollToSegment(item.id);
                        } else {
                          switchActiveProject(item.projectId).then(() => {
                            setTimeout(() => scrollToSegment(item.id), 250);
                          });
                        }
                      }}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-extrabold border transition-all flex-shrink-0 cursor-pointer shadow-xs active:scale-95 ${
                        isWaiting
                          ? 'bg-amber-500/25 hover:bg-amber-500/40 text-amber-300 hover:text-amber-200 border-amber-500/50 hover:border-amber-400 animate-pulse'
                          : 'bg-indigo-500/20 hover:bg-indigo-500/35 text-indigo-300 hover:text-indigo-200 border-indigo-500/40 hover:border-indigo-400'
                      }`}
                      title={`클릭 시 세그먼트 ${item.numberStr}번으로 스크롤${isWaiting ? ` (1분 대기 중: ${item.retryCountdown}초)` : ''}`}
                    >
                      {item.episodeBadge && (
                        <span className="text-[10px] text-zinc-400 font-bold">{item.episodeBadge}</span>
                      )}
                      <span>세그먼트 {item.numberStr}</span>
                      <span className="text-[10px] text-indigo-300 font-mono font-bold">
                        {Math.round(item.progress)}%
                      </span>
                      {isWaiting && (
                        <span className="text-[10px] text-amber-300 font-mono font-bold flex items-center gap-0.5">
                          <Clock size={10} className="animate-spin" />
                          <span>{item.retryCountdown}s</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 중지 버튼 */}
              <div className="flex items-center gap-1 flex-shrink-0 pl-1 border-l border-zinc-700/80">
                <button
                  onClick={stopAllGeneration}
                  className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 hover:text-red-200 border border-red-500/30 hover:border-red-400/50 rounded-xl text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
                  title="전체 오디오 생성 중지"
                >
                  <Square size={11} fill="currentColor" />
                  <span className="text-[11px] hidden sm:inline">중지</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="fixed bottom-8 right-8 flex flex-col gap-2 z-50"><button onClick={scrollToTop} className="p-3 bg-white dark:bg-zinc-900 border border-zinc-200 rounded-full shadow-lg text-zinc-500"><ArrowUp size={20} /></button><button onClick={scrollToBottom} className="p-3 bg-white dark:bg-zinc-900 border border-zinc-200 rounded-full shadow-lg text-zinc-500"><ArrowDown size={20} /></button></div>
      </div>
    </div>
  );
};

export default PodcastStudio;
