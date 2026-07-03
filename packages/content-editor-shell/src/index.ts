export {
  ContentEditorShell,
  type ContentEditorShellProps,
  type ContentEditorAutosaveState,
  type ContentEditorCanvasBlock,
  type ContentEditorInspectorPanel,
  type ContentEditorInsertAction,
  type ContentEditorPreview,
  type ContentEditorVersionSummary,
} from './shell.js';
export {
  createContentEditorFixture,
  fixtureChannelLabel,
  type ContentEditorFixtureOptions,
} from './fixtures.js';
export {
  // Layout
  EditorChrome,
  type EditorChromeProps,
  EditorTopBar,
  type EditorTopBarProps,
  EditorLeftRail,
  type EditorLeftRailProps,
  type EditorMode,
  InspectorPanel,
  type InspectorPanelProps,
  InspectorReopenButton,
  MobileInsertButton,
  // Insert popovers
  InsertPopoverButton,
  type InsertPopoverButtonProps,
  InsertPopoverItem,
  // Metadata
  MetadataBar,
  MetadataField,
  type MetadataFieldProps,
  // Types
  type DropdownMenuItemConfig,
  // Badges
  AutosaveBadge,
  StatusBadge,
} from './chrome.js';
export {
  // UI primitives (shadcn-style, Radix-based)
  Button,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  inputClassName,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './ui.js';
export { cn } from './cn.js';
