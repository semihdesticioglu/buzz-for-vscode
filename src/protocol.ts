// What the extension and the chat webview say to each other. The webview script (media/chat.js) handles exactly
// these messages; when one side changes, the other follows.
import type { CodeContext, Draft, Presence } from './core';
import type { Lang } from './i18n';
import type { JiraIssue } from './jira';
import type { LiveStateName } from './liveRelay';

/** A channel note (post-it) at the top of the chat. */
export interface ChannelNote {
  id: string;
  name: string;
  isDm: boolean;
  color: number;
  /** DM: the other person, for the presence dot */
  peer?: string;
}

export interface Participant {
  pubkey: string;
  name: string;
  initials: string;
  isAgent: boolean;
}

/** One row of the thread list. */
export interface ThreadRow {
  id: string;
  pubkey?: string;
  author: string;
  initials: string;
  isAgent: boolean;
  isMe: boolean;
  snippet: string;
  replies: number;
  lastAuthor?: string;
  lastIsMe: boolean;
  people: Participant[];
  time: string;
  ts: number;
}

export type SearchScope = 'channel' | 'all';

/** One search result: the thread, the message that matched best (the newest), the channel it is in. */
export interface SearchRow {
  /** thread root */
  id: string;
  channelId: string;
  channelName: string;
  matchId: string;
  matches: number;
  pubkey: string;
  author: string;
  initials: string;
  isAgent: boolean;
  isMe: boolean;
  snippet: string;
  time: string;
  ts: number;
}

/** A proposal bar under a code block: Show diff, and Apply in the opt-in local mode. */
export interface PatchBar {
  block: number;
  files: string[];
  local: boolean;
}

/** Work an agent reports (a branch, a commit): a bar with Show diff. */
export interface GitBar {
  branches: string[];
  commits: string[];
}

/** One message of the open thread. */
export interface MessageItem {
  id: string;
  pubkey: string;
  author: string;
  initials: string;
  isMe: boolean;
  isAgent: boolean;
  isRoot: boolean;
  time: string;
  ts: number;
  html: string;
  patches: PatchBar[];
  git?: GitBar;
  /** 0: top level of the thread; 1+: a reply to a reply */
  depth: number;
  parentId?: string;
  parentAuthor?: string;
  /** for the "Replying to" bar */
  snippet: string;
}

/** A chip above the composer: code, a problem or terminal output that goes with the next message. */
export interface ContextChip {
  label: string;
  kind: NonNullable<CodeContext['kind']>;
  title: string;
}

export interface MemberItem {
  pubkey: string;
  name: string;
  isAgent: boolean;
}

export interface Typist {
  name: string;
  isAgent: boolean;
}

/** Someone typing or an agent working; `real` is a typing signal, otherwise our guess after mentioning an agent. */
export interface WorkingItem extends Typist {
  real: boolean;
}

export interface JiraCard extends JiraIssue {
  estimateText?: string;
  spentText: string;
}

/** Extension -> webview. */
export type ToWebview =
  | { type: 'i18n'; lang: Lang; strings: Record<string, string> }
  | { type: 'host'; kind: 'view' | 'panel' }
  | { type: 'live'; state: LiveStateName; detail?: string; reason?: 'certificate' }
  | { type: 'channels'; ready: true; items: ChannelNote[] }
  | { type: 'channels'; ready: false; error: string; setup: boolean }
  | { type: 'channel'; id: string; name: string; isDm: boolean; color: number }
  | { type: 'threads'; channelId: string; items: ThreadRow[]; initial: boolean; more: boolean }
  | { type: 'searchResults'; query: string; scope: SearchScope; items: SearchRow[]; capped: boolean; cap: number; error?: string }
  | { type: 'thread'; id: string | null; title: string; items: MessageItem[]; flash?: string[]; reveal?: boolean; notice?: string; partial?: boolean }
  | { type: 'threadAppend'; id: string; items: MessageItem[] }
  | { type: 'olderDone' }
  | { type: 'elsewhere'; count: number; thread: string; author: string; snippet: string }
  | { type: 'members'; items: MemberItem[] }
  | { type: 'presence'; map: Record<string, Presence> }
  | { type: 'working'; items: WorkingItem[]; busy: string[]; channel: Typist[] }
  | { type: 'agentsOffline'; offline: boolean; names: string[] }
  | { type: 'contexts'; items: ContextChip[] }
  | { type: 'focusInput' }
  | { type: 'drafts'; items: Record<string, Draft> } // on load: "channel:thread" / "channel:new" -> what was typed there
  | { type: 'sending'; on: boolean }
  | { type: 'sent'; text: string }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'toast'; message: string; ok?: boolean }
  | { type: 'jiraInfo'; key: string; data: JiraCard }
  | { type: 'jiraInfo'; key: string; error: string; needsToken: boolean };

/** Webview -> extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  | { type: 'openThread'; id: string }
  | { type: 'newThread' }
  | { type: 'send'; text: string; mentions?: string[]; replyTo?: string; thread?: string | null; channel?: string } // channel: the one on screen
  | { type: 'typing' }
  | { type: 'drafts'; items: Record<string, Draft> } // the composer's drafts changed: kept by the extension
  | { type: 'openDesktop' }
  | { type: 'channelMenu' }
  | { type: 'attachSelection' }
  | { type: 'removeContext'; index: number }
  | { type: 'older' }
  | { type: 'search'; query: string; scope: SearchScope }
  | { type: 'openResult'; channel: string; id: string }
  | { type: 'refresh' }
  | { type: 'setup' }
  | { type: 'setLanguage'; lang: string }
  | { type: 'openRef'; path: string; line?: number; end?: number }
  | { type: 'gitDiff'; id: string }
  | { type: 'patchDiff'; id: string; block: number }
  | { type: 'patchApply'; id: string; block: number }
  | { type: 'jiraInfo'; key: string }
  | { type: 'setJiraToken' }
  | { type: 'wide' }
  | { type: 'copy'; text: string }
  | { type: 'open'; url: string };
