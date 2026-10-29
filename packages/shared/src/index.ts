export type RootId = 'downloads' | 'plex';
export interface Location {
  root: RootId;
  path: string;
}
export interface Root {
  id: RootId;
  name: string;
  available: boolean;
  free?: number;
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
