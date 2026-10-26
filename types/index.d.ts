// Ids of the transcript rows that hold text Claude wrote before a tool call.
export type Narration = string[]
// Short hashes of paragraphs, for rows no id reached the mod for.
export type Hashes = string[]

declare module 'claude-code' {
  interface PluginState {
    'quiet-transcript': {
      narration: Narration
      // Paragraphs Claude wrote in a step that also called a tool.
      asides: Hashes
      // Paragraphs Claude wrote in a step that called none.
      answers: Hashes
      // Whether a quieted tool row shows the app's own full card, per row.
      isOpen: StateFamily<boolean>
    }
  }
}
