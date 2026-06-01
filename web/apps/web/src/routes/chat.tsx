import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { Send, RotateCcw, ChevronDown, ChevronRight, Wrench, Brain } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { loadLLMConfig, loadAllModels, runChatAgentStream, createReasoningCache, type LLMConfig, type ModelOption, type StepInfo } from '@/lib/chat-agent'
import { MarkdownContent } from '@/components/markdown'
import { ScreenResultCard } from '@/components/screen-result-card'
import { AIDisclaimer } from '@/components/ai-disclaimer'
import { usePreferences, type TranslationKey } from '@/lib/preferences'

const TOOL_LABEL_KEYS: Record<string, TranslationKey> = {
  search_stock: 'tool.search_stock',
  view_portfolio: 'tool.view_portfolio',
  market_overview: 'tool.market_overview',
  market_history: 'tool.market_history',
  query_recommendations: 'tool.query_recommendations',
  query_tail_buy: 'tool.query_tail_buy',
  plan_portfolio_update: 'tool.plan_portfolio_update',
  execute_portfolio_update: 'tool.execute_portfolio_update',
  analyze_stock: 'tool.analyze_stock',
  screen_stocks: 'tool.screen_stocks',
  trigger_funnel_screening: 'tool.trigger_funnel_screening',
  generate_ai_report: 'tool.generate_ai_report',
  generate_strategy_decision: 'tool.generate_strategy_decision',
}

let msgIdCounter = 0

interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  isError?: boolean
  steps?: StepInfo[]
}

// ── Chat History Persistence (localStorage) ──────────────────────
const CHAT_SESSIONS_KEY = 'wyckoff_chat_sessions'
const CHAT_SESSION_PREFIX = 'wyckoff_chat_session_'
const MAX_SESSIONS = 20

interface ChatSessionMeta {
  id: string
  title: string
  updatedAt: string
}

interface PersistedMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  isError?: boolean
}

function loadSessionList(): ChatSessionMeta[] {
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveSessionList(sessions: ChatSessionMeta[]) {
  try {
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)))
  } catch { /* quota exceeded */ }
}

function loadSessionMessages(sessionId: string): Message[] {
  try {
    const raw = localStorage.getItem(CHAT_SESSION_PREFIX + sessionId)
    if (!raw) return []
    const items: PersistedMessage[] = JSON.parse(raw)
    return items.map(m => ({ ...m, id: m.id || ++msgIdCounter }))
  } catch { return [] }
}

function saveSessionMessages(sessionId: string, messages: Message[]) {
  try {
    const persistable: PersistedMessage[] = messages
      .filter(m => !m.isError)
      .map(m => ({ id: m.id, role: m.role, content: m.content, isError: m.isError }))
    localStorage.setItem(CHAT_SESSION_PREFIX + sessionId, JSON.stringify(persistable))
  } catch { /* quota exceeded */ }
}

function makeSessionTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === 'user')
  if (firstUser) return firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '...' : '')
  return '新对话'
}

function removeSession(sessionId: string) {
  try { localStorage.removeItem(CHAT_SESSION_PREFIX + sessionId) } catch { /* */ }
}

function StepsCollapsible({ steps }: { steps: StepInfo[] }) {
  const [expanded, setExpanded] = useState(false)
  const { t } = usePreferences()

  if (steps.length === 0) return null

  const toolCalls = steps.filter((s) => s.type === 'tool_call')
  const summary = toolCalls.length > 0
    ? t('chat.toolCalls', { count: toolCalls.length })
    : t('chat.reasoningSteps', { count: steps.length })

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        <ChevronRight size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span>{summary}</span>
      </button>
      {expanded && (
        <div className="mt-1.5 ml-3 space-y-1 border-l-2 border-border/50 pl-2.5">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {step.type === 'tool_call' ? (
                <>
                  <Wrench size={10} className="text-amber-500" />
                  <span>{formatToolName(step.toolName, t)}</span>
                </>
              ) : (
                <>
                  <Brain size={10} className="text-blue-500" />
                  <span className="line-clamp-1">{step.text?.slice(0, 80)}…</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({ msg }: { msg: Message }) {
  return (
    <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
          msg.role === 'user'
            ? 'bg-primary text-primary-foreground whitespace-pre-wrap'
            : msg.isError
              ? 'border border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
              : 'bg-muted text-foreground'
        }`}
      >
        {msg.role === 'user' ? (
          msg.content
        ) : (
          <>
            {msg.steps && msg.steps.length > 0 && <StepsCollapsible steps={msg.steps} />}
            {msg.steps?.map((s, i) => {
              if (s.toolName !== 'screen_stocks' || !s.toolResult) return null
              try { return <ScreenResultCard key={i} data={JSON.parse(s.toolResult)} /> } catch { return null }
            })}
            <MarkdownContent content={msg.content} />
          </>
        )}
      </div>
    </div>
  )
})

function ChatComposer(props: {
  input: string
  loading: boolean
  onInput: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
}) {
  const { t } = usePreferences()
  return (
    <div className="border-t border-border px-6 py-3">
      <form onSubmit={props.onSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={props.input}
          onChange={(e) => props.onInput(e.target.value)}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          className="flex-1 rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/20"
        />
        <button type="submit" disabled={!props.input.trim() || props.loading} className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40">
          <Send size={16} />
        </button>
      </form>
      <div className="mt-2 text-center"><AIDisclaimer /></div>
    </div>
  )
}

function ModelPicker(props: {
  llmConfig: LLMConfig
  models: ModelOption[]
  show: boolean
  pickerRef: React.RefObject<HTMLDivElement | null>
  onToggle: () => void
  onSelect: (m: ModelOption) => void
}) {
  return (
    <div className="relative" ref={props.pickerRef}>
      <button
        onClick={props.onToggle}
        className="flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] text-indigo-700 transition-colors hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-200 dark:hover:bg-indigo-500/20"
      >
        {props.llmConfig.model}
        <ChevronDown size={10} />
      </button>
      {props.show && props.models.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-background shadow-lg">
          {props.models.map((m) => (
            <button
              key={`${m.provider}-${m.model}`}
              onClick={() => props.onSelect(m)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-muted/50 ${
                m.model === props.llmConfig.model ? 'bg-muted/30 font-medium' : ''
              }`}
            >
              <span>{m.model}</span>
              <span className="text-muted-foreground">{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ChatHeader(props: {
  llmConfig: LLMConfig | null
  models: ModelOption[]
  user: ReturnType<typeof useAuthStore.getState>['user']
  showModelPicker: boolean
  pickerRef: React.RefObject<HTMLDivElement | null>
  onToggleModelPicker: () => void
  onSelectModel: (m: ModelOption) => void
  onNewChat: () => void
  sessionId: string
  sessionList: ChatSessionMeta[]
  onSwitchSession: (sId: string) => void
  t: (key: TranslationKey) => string
}) {
  const [showSessions, setShowSessions] = useState(false)
  return (
    <div className="flex items-center justify-between border-b border-border px-6 py-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{props.t('chat.title')}</h1>
        <ChatModelBadge llmConfig={props.llmConfig} models={props.models} showModelPicker={props.showModelPicker}
          pickerRef={props.pickerRef} onToggleModelPicker={props.onToggleModelPicker} onSelectModel={props.onSelectModel}
          user={props.user} t={props.t} />
      </div>
      <div className="flex items-center gap-2">
        <ChatSessionDropdown sessions={props.sessionList} sessionId={props.sessionId}
          show={showSessions} onToggle={() => setShowSessions(!showSessions)} onSwitch={props.onSwitchSession} t={props.t} />
        <button onClick={props.onNewChat}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted/50">
          <RotateCcw size={14} />
          {props.t('chat.newChat')}
        </button>
      </div>
    </div>
  )
}

function ChatModelBadge({ llmConfig, models, showModelPicker, pickerRef, onToggleModelPicker, onSelectModel, user, t }: {
  llmConfig: LLMConfig | null; models: ModelOption[]; showModelPicker: boolean; pickerRef: React.RefObject<HTMLDivElement | null>
  onToggleModelPicker: () => void; onSelectModel: (m: ModelOption) => void
  user: ReturnType<typeof useAuthStore.getState>['user']; t: (key: TranslationKey) => string
}) {
  if (llmConfig) {
    return (
      <ModelPicker llmConfig={llmConfig} models={models} show={showModelPicker} pickerRef={pickerRef}
        onToggle={onToggleModelPicker} onSelect={onSelectModel} />
    )
  }
  if (user) {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
        {t('chat.noApiKey')}
      </span>
    )
  }
  return null
}

function ChatSessionDropdown({ sessions, sessionId, show, onToggle, onSwitch, t }: {
  sessions: ChatSessionMeta[]; sessionId: string; show: boolean; onToggle: () => void
  onSwitch: (sId: string) => void; t: (key: TranslationKey) => string
}) {
  if (sessions.length <= 1) return null
  return (
    <div className="relative">
      <button onClick={onToggle} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50">
        {t('chat.history') || '历史'}
        <ChevronDown size={12} />
      </button>
      {show && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-border bg-background shadow-lg" onMouseLeave={onToggle}>
          {sessions.slice(0, 8).map(s => (
            <button key={s.id} onClick={() => { onSwitch(s.id); onToggle() }}
              className={`w-full truncate px-3 py-1.5 text-left text-xs hover:bg-muted/50 ${s.id === sessionId ? 'bg-muted/30 font-medium' : ''}`}>
              {s.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ChatEmptyState(props: {
  onSelectPrompt: (q: string) => void
  t: (key: TranslationKey) => string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <div className="mb-4 text-4xl">📈</div>
      <p className="text-sm font-medium">{props.t('chat.emptyTitle')}</p>
      <p className="mt-2 text-xs text-muted-foreground">{props.t('chat.tryAsk')}</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {[
          props.t('chat.prompt.portfolio'),
          props.t('chat.prompt.market'),
          props.t('chat.prompt.recent'),
          props.t('chat.prompt.search'),
          props.t('chat.prompt.screen'),
          props.t('chat.prompt.strategy'),
        ].map((q) => (
          <button
            key={q}
            onClick={() => props.onSelectPrompt(q)}
            className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted/50"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChatMessageList(props: {
  messages: Message[]
  loading: boolean
  liveSteps: StepInfo[]
  streamingText: string
  t: (key: TranslationKey) => string
}) {
  return (
    <div className="space-y-4">
      {props.messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}

      {props.loading && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground">
            {props.liveSteps.length > 0 && (
              <div className="mb-2 space-y-1">
                {props.liveSteps.map((step, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {step.type === 'tool_call' ? (
                      <>
                        <Wrench size={10} className="text-amber-500" />
                        <span>✓ {formatToolName(step.toolName, props.t)}</span>
                      </>
                    ) : (
                      <>
                        <Brain size={10} className="text-blue-500" />
                        <span className="line-clamp-1">{step.text?.slice(0, 60)}…</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {props.streamingText ? (
              <MarkdownContent content={props.streamingText} />
            ) : (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                <span>{props.liveSteps.length > 0 ? props.t('chat.generating') : props.t('chat.thinking')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function ChatPage() {
  const user = useAuthStore((s) => s.user)
  const { t } = usePreferences()
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionList, setSessionList] = useState<ChatSessionMeta[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [liveSteps, setLiveSteps] = useState<StepInfo[]>([])
  const [streamingText, setStreamingText] = useState('')
  const streamBufRef = useRef('')
  const streamFlushRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const reasoningCacheRef = useRef(createReasoningCache())
  const pickerRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef(0)
  const currentSessionIdRef = useRef('')

  // Init: load sessions and most recent chat
  useEffect(() => {
    if (user) {
      loadLLMConfig(user.id).then(setLlmConfig)
      loadAllModels(user.id).then(setModels)
    }
    const sessions = loadSessionList()
    setSessionList(sessions)
    if (sessions.length > 0) {
      const latest = sessions[0]!
      setSessionId(latest.id)
      currentSessionIdRef.current = latest.id
      const msgs = loadSessionMessages(latest.id)
      if (msgs.length > 0) setMessages(msgs)
    } else {
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      setSessionId(newId)
      currentSessionIdRef.current = newId
    }
  }, [user])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const scrollToBottom = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      cancelAnimationFrame(scrollRafRef.current)
      cancelAnimationFrame(streamFlushRef.current)
    }
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, liveSteps, scrollToBottom])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || loading) return

    if (!llmConfig) {
      setError(t('chat.configureLLM'))
      return
    }

    const userMsg: Message = { id: ++msgIdCounter, role: 'user', content: input.trim() }
    const nextMessages = [...messages, userMsg]
    const chatHistory = nextMessages
      .filter((m) => !m.isError)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    setMessages(nextMessages)
    setInput('')
    setError('')
    setLoading(true)
    setLiveSteps([])
    setStreamingText('')

    abortRef.current = runChatAgentStream(
      llmConfig,
      user!.id,
      chatHistory,
      {
        onStep: (step) => {
          setLiveSteps((prev) => [...prev, step])
          streamBufRef.current = ''
          setStreamingText('')
        },
        onTextDelta: (delta) => {
          streamBufRef.current += delta
          if (!streamFlushRef.current) {
            streamFlushRef.current = requestAnimationFrame(() => {
              setStreamingText(streamBufRef.current)
              scrollToBottom()
              streamFlushRef.current = 0
            })
          }
        },
        onFinish: (finalText, steps) => {
          cancelAnimationFrame(streamFlushRef.current)
          streamFlushRef.current = 0
          streamBufRef.current = ''
          let updatedMessages: Message[] = []
          if (finalText) {
            updatedMessages = [...nextMessages, { id: ++msgIdCounter, role: 'assistant', content: finalText, steps }]
            setMessages(updatedMessages)
          } else {
            updatedMessages = nextMessages
          }
          // Save chat history to localStorage
          if (currentSessionIdRef.current && updatedMessages.length > 0) {
            saveSessionMessages(currentSessionIdRef.current, updatedMessages)
            const title = makeSessionTitle(updatedMessages)
            const now = new Date().toISOString()
            const list = loadSessionList()
            const idx = list.findIndex(s => s.id === currentSessionIdRef.current)
            const meta: ChatSessionMeta = { id: currentSessionIdRef.current, title, updatedAt: now }
            if (idx >= 0) {
              list.splice(idx, 1)
              list.unshift(meta)
            } else {
              list.unshift(meta)
            }
            saveSessionList(list)
            setSessionList(list)
          }
          setStreamingText('')
          setLiveSteps([])
          setLoading(false)
          abortRef.current = null
        },
        onError: (err) => {
          cancelAnimationFrame(streamFlushRef.current)
          streamFlushRef.current = 0
          streamBufRef.current = ''
          const msg = err.message || t('chat.requestFailed')
          setError(msg)
          setMessages((prev) => [...prev, { id: ++msgIdCounter, role: 'assistant', content: `⚠️ ${msg}`, isError: true }])
          setStreamingText('')
          setLiveSteps([])
          setLoading(false)
          abortRef.current = null
        },
      },
      reasoningCacheRef.current,
    )
  }, [input, loading, llmConfig, messages, t, user, scrollToBottom])

  const handleNewChat = useCallback(() => {
    // Save current session before creating new one
    if (currentSessionIdRef.current && messages.length > 0) {
      saveSessionMessages(currentSessionIdRef.current, messages)
      const title = makeSessionTitle(messages)
      const now = new Date().toISOString()
      const list = loadSessionList()
      const idx = list.findIndex(s => s.id === currentSessionIdRef.current)
      const meta: ChatSessionMeta = { id: currentSessionIdRef.current, title, updatedAt: now }
      if (idx >= 0) {
        list.splice(idx, 1)
        list.unshift(meta)
      } else {
        list.unshift(meta)
      }
      saveSessionList(list)
      setSessionList(list)
    }
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    setSessionId(newId)
    currentSessionIdRef.current = newId
    abortRef.current?.abort()
    abortRef.current = null
    reasoningCacheRef.current = createReasoningCache()
    setMessages([])
    setLiveSteps([])
    setStreamingText('')
    setError('')
    setLoading(false)
  }, [messages])

  const handleSwitchSession = useCallback((sId: string) => {
    if (currentSessionIdRef.current && messages.length > 0) {
      saveSessionMessages(currentSessionIdRef.current, messages)
      const title = makeSessionTitle(messages)
      const now = new Date().toISOString()
      const list = loadSessionList()
      const idx = list.findIndex(s => s.id === currentSessionIdRef.current)
      const meta: ChatSessionMeta = { id: currentSessionIdRef.current, title, updatedAt: now }
      if (idx >= 0) {
        list.splice(idx, 1)
        list.unshift(meta)
      } else {
        list.unshift(meta)
      }
      saveSessionList(list)
      setSessionList(list)
    }
    abortRef.current?.abort()
    abortRef.current = null
    reasoningCacheRef.current = createReasoningCache()
    setSessionId(sId)
    currentSessionIdRef.current = sId
    const msgs = loadSessionMessages(sId)
    setMessages(msgs)
    setLiveSteps([])
    setStreamingText('')
    setError('')
    setLoading(false)
  }, [messages])

  return (
    <div className="flex h-full flex-col">
      <ChatHeader
        llmConfig={llmConfig}
        models={models}
        user={user}
        showModelPicker={showModelPicker}
        pickerRef={pickerRef}
        onToggleModelPicker={() => setShowModelPicker(!showModelPicker)}
        onSelectModel={(m) => {
          setLlmConfig({ api_key: m.api_key, model: m.model, base_url: m.base_url, protocol: m.protocol })
          setShowModelPicker(false)
        }}
        onNewChat={handleNewChat}
        sessionId={sessionId}
        sessionList={sessionList}
        onSwitchSession={handleSwitchSession}
        t={t}
      />

      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4">
        {messages.length === 0 && !loading ? (
          <ChatEmptyState onSelectPrompt={setInput} t={t} />
        ) : (
          <ChatMessageList messages={messages} loading={loading} liveSteps={liveSteps} streamingText={streamingText} t={t} />
        )}
      </div>

      {error && (
        <div className="mx-6 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-200">{error}</div>
      )}

      <ChatComposer input={input} loading={loading} onInput={setInput} onSubmit={handleSubmit} />
    </div>
  )
}

function formatToolName(
  toolName: string | undefined,
  t: (key: TranslationKey) => string,
): string {
  if (!toolName) return ''
  const labelKey = TOOL_LABEL_KEYS[toolName]
  return labelKey ? t(labelKey) : toolName
}
