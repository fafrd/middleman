import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import {
  CHECK_LIST,
  HEADING,
  MULTILINE_ELEMENT_TRANSFORMERS,
  ORDERED_LIST,
  QUOTE,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  UNORDERED_LIST,
} from '@lexical/markdown'
import { ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'

export const NOTES_EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode]

// Lexical's built-in TRANSFORMERS omit CHECK_LIST, so it has to run before unordered lists.
export const NOTES_MARKDOWN_TRANSFORMERS = [
  HEADING,
  QUOTE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  ...TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
]
