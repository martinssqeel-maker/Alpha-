const LEADING_REQUEST = /^(?:(?:please|kindly)[,\s]+|(?:can|could|would) you\s+|help me\s+|i need you to\s+|i want you to\s+)/i

function stripRequestPrefix(value: string): string {
  let current = value
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(LEADING_REQUEST, '').trim()
  }
  return current
}

function titleWords(value: string): string[] {
  return value
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#._'-]+$/gu, ''))
    .filter(Boolean)
}

/** Derive a short, offline-safe title from the first user request. */
export function createConversationTitle(text: string, attachmentNames: string[] = []): string {
  const readable = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  let source = readable.split(/(?<=[.!?])\s/)[0] ?? ''
  source = stripRequestPrefix(source)

  let words = titleWords(source)
  if (words.length === 0) {
    const attachment = attachmentNames[0]?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') ?? ''
    words = titleWords(attachment)
  }

  const title = words.slice(0, 6).join(' ')
  if (!title) return 'New chat'

  return title
    .split(' ')
    .map((word, index) => {
      if (index === 0) return word[0].toLocaleUpperCase() + word.slice(1)
      return word
    })
    .join(' ')
}
