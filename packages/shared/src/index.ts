export type RootId = 'downloads' | 'plex';
export interface Location {
  root: RootId;
  path: string;
}
export type DownloadStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'failed'
  | 'publishing'
  | 'publication-failed'
  | 'completed'
  | 'cancelled'
  | 'missing';
export interface DownloadEngine {
  status: 'disabled' | 'connecting' | 'connected' | 'unavailable' | 'misconfigured';
  version?: string;
  message?: string;
}
export interface Download {
  id: string;
  name: string;
  createdAt: string;
  status: DownloadStatus;
  downloaded: number;
  total: number;
  speed: number;
  actions: DownloadAction[];
  error?: string;
  result?: Location;
  destination?: Location;
  multipart?: DownloadPart & { expected: number };
}
export type DownloadAccountProvider =
  | '1fichier'
  | '1fichier-web'
  | 'mega'
  | 'real-debrid'
  | 'terabox'
  | 'nitroflare'
  | 'rapidgator'
  | 'katfile';
export type DownloadAccountStatus =
  | 'unchecked'
  | 'connected'
  | 'invalid'
  | 'unavailable'
  | 'captcha'
  | 'restricted'
  | 'rate-limited'
  | 'two-factor';
export interface DownloadAccount {
  id: string;
  provider: DownloadAccountProvider;
  label: string;
  email?: string;
  status?: DownloadAccountStatus;
  checkedAt?: string;
}
export type DownloadLinkStatus = 'online' | 'offline' | 'captcha' | 'account-required' | 'unknown';
export interface DownloadLinkCheck {
  status: DownloadLinkStatus;
  name?: string;
  total?: number;
  message?: string;
  multipart?: DownloadPart;
}
export interface DownloadPart {
  key: string;
  name: string;
  part: number;
}
export interface DownloadGroup {
  id: string;
  name: string;
  tasks: Download[];
  expected?: number;
  missing?: number;
}
export interface DownloadSettings {
  destination: Location;
  accounts: DownloadAccount[];
}
export interface DownloadCounts {
  all: number;
  active: number;
  paused: number;
  issues: number;
  completed: number;
  cancelled: number;
  pausable: number;
  resumable: number;
  clearable: number;
}
export interface DownloadsPage {
  engine: DownloadEngine;
  tasks: Download[];
  groups: DownloadGroup[];
  total: number;
  active?: number;
  speed?: number;
  counts?: DownloadCounts;
}
export interface DownloadBulkResult {
  ok: number;
  skipped: number;
  failed: number;
}
export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'remove' | 'publish';
export interface Root {
  id: RootId;
  name: string;
  available: boolean;
  free?: number;
}
export interface SummaryTrack {
  codec: string;
  bitrate?: number;
  bitrateMode: string;
  language: string;
  title: string;
  channels?: number;
  layout: string;
  sampleRate?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  bitDepth?: number;
  hdr: string;
  color: string;
}
export interface MediaSummary {
  location: Location;
  size: number;
  container: string;
  duration?: number;
  bitrate?: number;
  videos: SummaryTrack[];
  audios: SummaryTrack[];
}
export interface Entry {
  name: string;
  location: Location;
  kind: 'directory' | 'file' | 'blocked';
  size: number;
  modified: string;
  extension: string;
}
export type JobKind = 'copy' | 'move' | 'delete' | 'extract' | 'remux' | 'makemkv' | 'disc';
export type JobStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Track {
  id: number;
  type: 'video' | 'audio' | 'subtitles';
  codec: string;
  language: string;
  name: string;
  channels?: number;
  resolution?: string;
  default: boolean;
  forced: boolean;
}
export interface Media {
  location: Location;
  revision?: string;
  title: string;
  tracks: Track[];
}
export interface MetadataRequest {
  source: Location;
  revision: string;
  title: string;
  tracks: Pick<Track, 'id' | 'name' | 'language' | 'default' | 'forced'>[];
}
export interface TrackChoice {
  source: number;
  id: number;
  enabled: boolean;
  name: string;
  language: string;
  default: boolean;
  forced: boolean;
}
export interface RemuxRequest {
  sources: Location[];
  tracks: TrackChoice[];
  title: string;
  destination: Location;
  name: string;
}
export interface DiscStream {
  id: number;
  type: string;
  codec: string;
  language: string;
  description: string;
}
export interface DiscTitle {
  id: number;
  name: string;
  duration: string;
  size: string;
  chapters: string;
  streams: DiscStream[];
}
export interface Disc {
  location: Location;
  titles: DiscTitle[];
  messages: string[];
}
export interface ReviewFile {
  index: number;
  name: string;
  title?: string;
  tracks: Track[];
}
export interface Job {
  revision?: number;
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sources: Location[];
  destination?: Location;
  progress: number | null;
  stage: string;
  messages: string[];
  results: Location[];
  error?: string;
  awaitingReview?: ReviewFile[];
  awaitingDisc?: Disc;
  dismissed?: boolean;
}
export interface ToolStatus {
  available: boolean;
  version?: string;
  error?: string;
}
export interface SystemStatus {
  tools: Record<'sevenZip' | 'mkvmerge' | 'mkvpropedit' | 'makemkv', ToolStatus>;
  concurrency: number;
}
