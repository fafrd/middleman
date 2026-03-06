interface ParsedCommand {
  commandPath: string[]
  options: Map<string, string[]>
}

interface EscalationResponse<T = unknown> {
  escalation?: T
  escalations?: T[]
  error?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:47187'

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)

  if (parsed.commandPath.length === 0 || hasHelpFlag(parsed)) {
    printUsage()
    return
  }

  const [namespace, action, maybeEscalationId] = parsed.commandPath
  if (namespace === 'task') {
    throw new Error('`middleman task` has been removed. Use `middleman escalation ...` instead.')
  }
  if (namespace !== 'escalation' && namespace !== 'escalate') {
    throw new Error(`Unknown command: ${parsed.commandPath.join(' ')}`)
  }

  switch (action) {
    case 'add':
      await handleEscalationAdd(parsed)
      return
    case 'list':
      await handleEscalationList(parsed)
      return
    case 'get':
      if (!maybeEscalationId) {
        throw new Error('escalation get requires an escalation id')
      }
      await handleEscalationGet(maybeEscalationId)
      return
    case 'close':
      if (!maybeEscalationId) {
        throw new Error('escalation close requires an escalation id')
      }
      await handleEscalationClose(maybeEscalationId, parsed)
      return
    default:
      throw new Error(`Unknown escalation command: ${action ?? '(missing)'}`)
  }
}

async function handleEscalationAdd(parsed: ParsedCommand): Promise<void> {
  const title = requireSingleOption(parsed, 'title')
  const description = requireSingleOption(parsed, 'description')
  const options = requireMultiOption(parsed, 'options')

  const response = await requestJson<EscalationResponse>('POST', '/api/escalations', {
    managerId: requireManagerId(),
    title,
    description,
    options,
  })

  printJson(response)
}

async function handleEscalationList(parsed: ParsedCommand): Promise<void> {
  const managerId = requireManagerId()
  const status = getOptionalSingleOption(parsed, 'status')
  if (status !== undefined && status !== 'open' && status !== 'resolved' && status !== 'all') {
    throw new Error('--status must be one of open, resolved, or all')
  }

  const url = new URL('/api/escalations', resolveApiBaseUrl())
  url.searchParams.set('managerId', managerId)
  if (status) {
    url.searchParams.set('status', status)
  }

  const response = await requestJson<EscalationResponse>('GET', url.pathname + url.search, undefined)
  printJson(response)
}

async function handleEscalationGet(escalationId: string): Promise<void> {
  const url = new URL(`/api/escalations/${encodeURIComponent(escalationId)}`, resolveApiBaseUrl())
  url.searchParams.set('managerId', requireManagerId())

  const response = await requestJson<EscalationResponse>('GET', url.pathname + url.search, undefined)
  printJson(response)
}

async function handleEscalationClose(escalationId: string, parsed: ParsedCommand): Promise<void> {
  const comment = getOptionalSingleOption(parsed, 'comment')

  const response = await requestJson<EscalationResponse>(
    'PATCH',
    `/api/escalations/${encodeURIComponent(escalationId)}`,
    {
      managerId: requireManagerId(),
      status: 'resolved',
      ...(comment !== undefined ? { comment } : {}),
    },
  )

  printJson(response)
}

function parseArgs(argv: string[]): ParsedCommand {
  const commandPath: string[] = []
  const options = new Map<string, string[]>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }

    const optionName = token.slice(2)
    if (!optionName) {
      throw new Error('Invalid empty option name')
    }

    if (optionName === 'help') {
      options.set(optionName, ['true'])
      continue
    }

    if (optionName === 'options') {
      const values: string[] = []
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) {
        values.push(argv[index + 1]!)
        index += 1
      }

      if (values.length === 0) {
        throw new Error('Option --options requires at least one value')
      }

      options.set(optionName, values)
      continue
    }

    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Option --${optionName} requires a value`)
    }

    options.set(optionName, [next])
    index += 1
  }

  return { commandPath, options }
}

function hasHelpFlag(parsed: ParsedCommand): boolean {
  return parsed.options.has('help') || parsed.commandPath.includes('--help')
}

function requireSingleOption(parsed: ParsedCommand, name: string): string {
  const value = getOptionalSingleOption(parsed, name)
  if (value === undefined) {
    throw new Error(`Missing required option --${name}`)
  }

  return value
}

function getOptionalSingleOption(parsed: ParsedCommand, name: string): string | undefined {
  const values = parsed.options.get(name)
  if (values === undefined) {
    return undefined
  }

  if (values.length !== 1) {
    throw new Error(`Option --${name} accepts exactly one value`)
  }

  const trimmed = values[0]?.trim()
  if (!trimmed) {
    throw new Error(`Option --${name} must be a non-empty string`)
  }

  return trimmed
}

function requireMultiOption(parsed: ParsedCommand, name: string): string[] {
  const values = parsed.options.get(name)
  if (!values || values.length === 0) {
    throw new Error(`Missing required option --${name}`)
  }

  return values.map((value) => {
    const trimmed = value.trim()
    if (!trimmed) {
      throw new Error(`Option --${name} must not contain blank values`)
    }

    return trimmed
  })
}

function requireManagerId(): string {
  const managerId = process.env.MIDDLEMAN_AGENT_ID?.trim()
  if (!managerId) {
    throw new Error('MIDDLEMAN_AGENT_ID is required')
  }

  return managerId
}

function resolveApiBaseUrl(): string {
  const explicit = process.env.MIDDLEMAN_API_BASE_URL?.trim()
  if (explicit) {
    return explicit
  }

  const host = process.env.MIDDLEMAN_HOST?.trim() || '127.0.0.1'
  const port = process.env.MIDDLEMAN_PORT?.trim() || '47187'
  return `http://${host}:${port}`
}

async function requestJson<T>(method: string, path: string, body: Record<string, unknown> | undefined): Promise<T> {
  const url = new URL(path, resolveApiBaseUrl())
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  const payload = text.trim().length > 0 ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`)
  }

  return payload
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printUsage(): void {
  const usage = [
    'Usage:',
    '  middleman escalation add --title "..." --description "..." --options "Option A" "Option B"',
    '  middleman escalation list [--status open|resolved|all]',
    '  middleman escalation get <id>',
    '  middleman escalation close <id> [--comment "..."]',
    '  middleman escalate <same-subcommands-as-escalation>',
    '',
    'Environment:',
    '  MIDDLEMAN_AGENT_ID   Manager/agent id used for escalation requests',
    `  MIDDLEMAN_API_BASE_URL   Backend base URL (default: ${DEFAULT_API_BASE_URL})`,
  ].join('\n')

  process.stdout.write(`${usage}\n`)
}

void main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
