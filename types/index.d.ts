// Short hashes of the paragraphs Claude wrote before a tool call.
export type Narration = string[]

declare module 'claude-code' {
  interface PluginState {
    'quiet-transcript': {
      narration: Narration
      // Whether a quieted tool row shows the app's own full card, per row.
      isOpen: StateFamily<boolean>
    }
  }
}
