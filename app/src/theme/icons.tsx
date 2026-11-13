// Icons are drawn as CSS masks from data URLs, so any icon set (or a theme override) is just data,
// takes the text color, and never runs as markup in the page.
import { createSignal } from "solid-js";
import {
  AudioLines, Check, ChevronUp, ZoomIn, ZoomOut, Download, Expand, MonitorX, Paperclip, Reply, SendHorizontal, Smile, VideoOff, CloudOff,
  Bot, Box, ChartColumn, ChevronDown, ChevronLeft, ChevronRight, CircleUser, Copy, File, Folder, GitBranch,
  HeadphoneOff, Headphones, Image, Info, Mic, MicOff, Minus, Monitor, PenTool, PhoneOff, Plus, Search, Settings,
  Shuffle, SmilePlus, Square, SquareCheckBig, Star, Table, Video, Wrench, X,
  MirrorRectangular, FlipHorizontal2, FlipVertical2, GripVertical, Bell, FolderPlus, FolderUp, FolderInput, RefreshCw, Images, LayoutGrid, LayoutList, Pencil, PencilLine, RotateCw, Scan, Trash2, Upload, UserRound, SquarePlus,
  Bold, Italic, Strikethrough, Code, List, ListOrdered, TextQuote, SquareCode, Link, Globe, MessageSquare, Tag, Columns3,
  ChartBar, Ellipsis, BringToFront, LayoutDashboard, Rows3, Columns3 as ColumnsIcon, MoveVertical, MoveHorizontal, ArrowUpDown, ArrowUp, ArrowDown, Scaling, Undo2, Redo2, History,
  LogOut, Speaker, Volume2, VolumeX, FileCode, Shrink, Pin, PinOff, HardDrive, Play, Pause, Popcorn, SquareTerminal, CircleStop, CircleX, TriangleAlert,
  Frame, Circle, Slash, Type, Spline, MousePointer2, Hand, Eye, EyeOff, Lock, LockOpen,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, TextAlignStart, TextAlignCenter, TextAlignEnd,
  Droplet, SquareRoundCorner, Crop, SquareDashed, Octagon, Sparkles, CircleHelp,
  Palette, Blend, Unlink, Underline, Group, Ungroup, BookOpen, FileText, Columns2, MessagesSquare,
  Archive, RectangleHorizontal, Puzzle, Diamond, Cylinder, Cloud, StickyNote, Baseline, PaintBucket, AppWindow, Component, NotebookPen, Menu,
} from "lucide-static";
import { theme } from "./store";
import { iconPack } from "./packs";
import emojiSymbols from "@material-symbols/svg-400/sharp/emoji_symbols.svg?raw";

// Drawn like lucide's text alignment icons (lines in a 24 box), for the design view's other text options.
const lines = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const textTop = lines(`<path d="M3 3h18"/><path d="M3 21h18"/><path d="M6 8h12"/><path d="M6 12h8"/>`);
const textMiddle = lines(`<path d="M3 3h18"/><path d="M3 21h18"/><path d="M6 10h12"/><path d="M6 14h8"/>`);
const textBottom = lines(`<path d="M3 3h18"/><path d="M3 21h18"/><path d="M6 12h12"/><path d="M6 16h8"/>`);
const autoWidth = lines(`<path d="M6 6h12"/><path d="M6 10h12"/><path d="M3 17h18"/><path d="m6 14-3 3 3 3"/><path d="m18 14 3 3-3 3"/>`);
const autoHeight = lines(`<path d="M3 6h11"/><path d="M3 12h11"/><path d="M3 18h7"/><path d="M19 3v18"/><path d="m16 6 3-3 3 3"/><path d="m16 18 3 3 3-3"/>`);
// The text channel mark from the design mockups: a bold hash turned to the left like a cog, with rounded ends.
const textChannel = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.3" stroke-linecap="round"><g transform="rotate(-22 12 12)"><path d="M8.2 5.5V18.5"/><path d="M15.8 5.5V18.5"/><path d="M5.5 8.2H18.5"/><path d="M5.5 15.8H18.5"/></g></svg>`;
const fixedSize = lines(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 9h10"/><path d="M7 13h10"/><path d="M7 17h6"/>`);
const parallelogram = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5h15l-5 14H2z"/></svg>`;
const diagramChannel = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="7" height="5" rx="1"/><rect x="14.5" y="16" width="7" height="5" rx="1"/><path d="M6 8v4h12v4M18 12h-5"/></svg>`;

const lucide = {
  "channel-chat": textChannel,
  "channel-voice": Mic,
  "channel-git": GitBranch,
  "channel-files": Folder,
  "channel-tasks": SquareCheckBig,
  "channel-design": PenTool,
  "channel-diagram": diagramChannel,
  "channel-docs": BookOpen,
  "docs-page": FileText,
  "channel-code": Code,
  "code-file": FileCode,
  "code-folder": Folder,
  "docs-preview": Eye,
  "docs-edit": Pencil,
  "docs-split": Columns2,
  "channel-stats": ChartColumn,
  "channel-table": Table,
  "channel-artboard": Images,
  "channel-browser": Globe,
  "channel-other": File,
  settings: Settings,
  search: Search,
  add: Plus,
  expanded: ChevronDown,
  collapsed: ChevronRight,
  back: ChevronLeft,
  forward: ChevronRight,
  profile: CircleUser,
  "sign-out": LogOut,
  volume: Volume2,
  speaker: Speaker,
  "volume-off": VolumeX,
  admin: Wrench,
  camera: Video,
  "screen-share": Monitor,
  mic: Mic,
  "mic-off": MicOff,
  headset: Headphones,
  "headset-off": HeadphoneOff,
  "hang-up": PhoneOff,
  close: X,
  "add-reaction": SmilePlus,
  bot: Bot,
  plugin: Puzzle,
  file: File,
  image: Image,
  star: Star,
  shuffle: Shuffle,
  box: Box,
  info: Info,
  "window-minimize": Minus,
  "window-maximize": Square,
  "window-restore": Copy,
  "window-close": X,
  "camera-off": VideoOff,
  "screen-share-stop": MonitorX,
  fullscreen: Expand,
  "fullscreen-exit": Shrink,
  activity: AudioLines,
  attach: Paperclip,
  send: SendHorizontal,
  download: Download,
  "cloud-off": CloudOff,
  emoji: Smile,
  reply: Reply,
  check: Check,
  "menu-up": ChevronUp,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  folder: Folder,
  storage: HardDrive,
  "folder-add": FolderPlus,
  "folder-up": FolderUp,
  "folder-upload": FolderInput,
  refresh: RefreshCw,
  upload: Upload,
  delete: Trash2,
  rename: Pencil,
  "view-grid": LayoutGrid,
  "view-list": LayoutList,
  flip: MirrorRectangular,
  "flip-h": FlipHorizontal2,
  "flip-v": FlipVertical2,
  grip: GripVertical,
  notification: Bell,
  rotate: RotateCw,
  "fit-all": Scan,
  assignee: UserRound,
  "tab-new": SquarePlus,
  "window-new": AppWindow,
  copy: Copy,
  "format-bold": Bold,
  "format-italic": Italic,
  "format-strike": Strikethrough,
  "format-underline": Underline,
  "format-code": Code,
  "format-list": List,
  "format-list-ordered": ListOrdered,
  "format-quote": TextQuote,
  "format-code-block": SquareCode,
  markdown: FileCode,
  link: Link,
  globe: Globe,
  comment: MessageSquare,
  messages: MessagesSquare,
  tag: Tag,
  columns: Columns3,
  poll: ChartBar,
  more: Ellipsis,
  "bring-to-front": BringToFront,
  "layout-grid": LayoutDashboard,
  "arrange-row": ColumnsIcon,
  "arrange-column": Rows3,
  "normalize-height": MoveVertical,
  "sort-reverse": ArrowUpDown,
  "sort-up": ArrowUp,
  "sort-down": ArrowDown,
  "normalize-width": MoveHorizontal,
  "normalize-size": Scaling,
  undo: Undo2,
  redo: Redo2,
  history: History,
  archive: Archive,
  pin: Pin,
  play: Play,
  pause: Pause,
  "watch-party": Popcorn,
  terminal: SquareTerminal,
  stop: CircleStop,
  error: CircleX,
  warning: TriangleAlert,
  unpin: PinOff,
  "design-move": MousePointer2,
  "design-hand": Hand,
  "take-control": Hand,
  "design-frame": Frame,
  "design-group": Group,
  "design-ungroup": Ungroup,
  "design-rect": Square,
  "design-ellipse": Circle,
  "design-line": Slash,
  "design-text": Type,
  "design-vector": Spline,
  "design-pen": PenTool,
  "design-pencil": PencilLine,
  "design-opacity": Droplet,
  "design-radius": SquareRoundCorner,
  "design-corners-each": SquareDashed,
  "design-corners-cut": Octagon,
  "design-effects": Sparkles,
  help: CircleHelp,
  "design-clip": Crop,
  "design-auto-width": autoWidth,
  "design-auto-height": autoHeight,
  "design-fixed-size": fixedSize,
  "design-palette": Palette,
  "design-gradient": Blend,
  "design-detach": Unlink,
  "design-component": Component,
  "design-instance": Diamond,
  notes: NotebookPen,
  menu: Menu,
  "diagram-rect": RectangleHorizontal,
  "diagram-rounded": SquareRoundCorner,
  "diagram-ellipse": Circle,
  "diagram-diamond": Diamond,
  "diagram-parallelogram": parallelogram,
  "diagram-cylinder": Cylinder,
  "diagram-document": FileText,
  "diagram-actor": UserRound,
  "diagram-cloud": Cloud,
  "diagram-note": StickyNote,
  "diagram-container": Frame,
  "diagram-swimlane": Columns2,
  "text-top": textTop,
  "text-middle": textMiddle,
  "text-bottom": textBottom,
  "align-left": AlignStartVertical,
  "align-h-center": AlignCenterVertical,
  "align-right": AlignEndVertical,
  "align-top": AlignStartHorizontal,
  "align-v-center": AlignCenterHorizontal,
  "align-bottom": AlignEndHorizontal,
  "distribute-h": AlignHorizontalDistributeCenter,
  "distribute-v": AlignVerticalDistributeCenter,
  "text-left": TextAlignStart,
  "text-center": TextAlignCenter,
  "text-right": TextAlignEnd,
  "text-color": Baseline,
  "cell-background": PaintBucket,
  visible: Eye,
  hidden: EyeOff,
  lock: Lock,
  unlock: LockOpen,
  remove: Minus,
  icons: emojiSymbols,
};

export type IconName = keyof typeof lucide;
export const iconNames = Object.keys(lucide) as IconName[];

export function isIconName(name: string): name is IconName {
  return name in lucide;
}

const toDataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;

// Icon packs: Lucide (built in), and others loaded the first time they are chosen. Icons a pack lacks come from
// Lucide.
type IconSet = { name: string; icons: Partial<Record<IconName, string>>; fallback?: string; credit?: string };
const iconSets = new Map<string, IconSet>([
  ["lucide", { name: "Lucide", icons: Object.fromEntries(Object.entries(lucide).map(([name, svg]) => [name, toDataUrl(svg)])) }],
]);
// `fallback`: the pack that draws what this one lacks (else Lucide).
const lazySets: Record<string, { name: string; credit?: string; load: () => Promise<{ icons: Record<string, string>; fallback?: string }> }> = {
  sharp: { name: "Sharp", credit: "Material Symbols by Google (Apache 2.0)", load: () => import("./iconPacks/sharp") },
  phosphor: { name: "Phosphor", credit: "Phosphor Icons (MIT)", load: () => import("./iconPacks/phosphor") },
  runic: { name: "Runic", credit: "game-icons.net by Lorc, Delapouite and contributors (CC BY 3.0)", load: () => import("./iconPacks/runic") },
};
const loading = new Set<string>();
const [setsChanged, setSetsChanged] = createSignal(0);

function ensureSet(id: string) {
  const lazy = lazySets[id];
  if (iconSets.has(id) || !lazy || loading.has(id)) return;
  loading.add(id);
  void lazy.load().then(({ icons, fallback }) => {
    iconSets.set(id, { name: lazy.name, credit: lazy.credit, fallback, icons: Object.fromEntries(Object.entries(icons).map(([name, svg]) => [name, toDataUrl(svg)])) });
    setSetsChanged((n) => n + 1);
  }, (e) => console.warn(`Icon pack '${id}' not loaded:`, e));
}

// For icon set plugins: values are data:image/svg+xml URLs. Icons a set lacks come from Lucide.
export function registerIconSet(id: string, icons: Partial<Record<IconName, string>>, name = id): void {
  iconSets.set(id, { name, icons });
  setSetsChanged((n) => n + 1);
}

export function iconSetList(): { id: string; name: string; credit?: string }[] {
  setsChanged();
  const listed = [...iconSets].map(([id, set]) => ({ id, name: set.name, credit: set.credit }));
  return [...listed, ...Object.entries(lazySets).filter(([id]) => !iconSets.has(id)).map(([id, set]) => ({ id, name: set.name, credit: set.credit }))];
}

// A name from the icon set, or a plugin's own data:image/svg+xml URL.
export function iconUrl(name: string): string {
  if (name.startsWith("data:image/svg+xml") && !/["\\\n\r]/.test(name)) return name;
  const icon: IconName = isIconName(name) ? name : "channel-other";
  // The icon pack picked in Settings > Appearance, or the theme's set and its own icons.
  const picked = iconPack();
  const { set, overrides } = theme().icons;
  const fromTheme = picked === "theme";
  const id = fromTheme ? set : picked;
  ensureSet(id);
  setsChanged();
  const pack = iconSets.get(id);
  if (pack?.fallback) ensureSet(pack.fallback);
  return (fromTheme ? overrides[icon] : undefined) ?? pack?.icons[icon]
    ?? (pack?.fallback ? iconSets.get(pack.fallback)?.icons[icon] : undefined) ?? iconSets.get("lucide")!.icons[icon]!;
}

export function Icon(props: { name: IconName | (string & {}); size?: number; label?: string }) {
  return (
    <span
      class="mw-icon"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      style={{ "--mw-icon": `url("${iconUrl(props.name)}")`, "--mw-icon-size": props.size ? `${props.size}px` : undefined }}
    />
  );
}
