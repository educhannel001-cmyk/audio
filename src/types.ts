export interface Voice {
  name: string;
  gender: string;
}

export interface PodcastSegment {
  id: string;
  text: string;
  seed: number;
  audioUrl?: string;
  hasAudio?: boolean;
  audioCreatedAt?: number;
  isGenerating?: boolean;
  progress?: number;
  volume?: number;
  error?: string;
  retryCountdown?: number;
}

export interface PodcastProject {
  id: string;
  name: string;
  script: string;
  voiceName: string;
  segments: PodcastSegment[];
  updatedAt?: number;
  createdAt?: number;
}
