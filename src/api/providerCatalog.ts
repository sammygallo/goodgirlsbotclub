// Provider Catalog — central registry of AI providers the app knows about.
//
// Two routing modes:
//   - nativeRouted: true  → backend has a dedicated chat_completion_source for
//                            this provider. Settings go in the provider's own
//                            oai_settings fields. Uses the provider's own
//                            SECRET_KEYS entry.
//   - nativeRouted: false → routes via chat_completion_source: 'custom'. The
//                            baseUrl + model + API key are swapped into the
//                            custom_url / custom_model / api_key_custom slot
//                            on activation. Used for OpenAI-compatible
//                            providers (Together, Fireworks, Hyperbolic, ...)
//                            and local servers (Ollama, LM Studio, ...).

export type ProviderKind = 'chat-completion' | 'text-completion';

export type ProviderCategory =
  | 'frontier' // OpenAI, Claude, Gemini, etc.
  | 'open' // OpenRouter-style aggregators with many models
  | 'aggregator' // Together, Fireworks, Hyperbolic — hosted open-source models
  | 'specialty' // Cohere, Perplexity, Mistral
  | 'local'; // Ollama, LM Studio, KoboldCpp, llama.cpp

export interface CatalogProvider {
  /** Stable id. For nativeRouted providers, matches chat_completion_source. */
  id: string;
  name: string;
  kind: ProviderKind;
  category: ProviderCategory;
  nativeRouted: boolean;
  /** For OpenAI-compat providers: the default base URL users can override. */
  baseUrl?: string;
  /** Secret key used by the backend. For user providers, backed by a dedicated slot. */
  secretKey: string;
  /**
   * True when this provider can generate *images* through a wired code path in
   * this app (not just chat). Today only OpenAI qualifies — its key is reused
   * by the DALL-E image backend via `/api/openai/generate-image`. Everything
   * else is text-only, which is what the "use my main provider" option and the
   * image-gen warning banner key off. Gemini/Imagen could join later once a
   * route exists; flip this flag then rather than hardcoding ids in the UI.
   */
  imageCapable?: boolean;
  /** Seed model list (may be refined by a /models probe). */
  defaultModels: readonly string[];
  /** Relative path appended to baseUrl for model listing. Defaults to "/models". */
  modelListEndpoint?: string;
  docsUrl?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Built-in catalog
// ---------------------------------------------------------------------------

/**
 * Native-routed providers. The SillyTavern backend has dedicated
 * chat_completion_source handling for each of these; the app configures them
 * via provider-specific oai_settings fields and a provider-specific secret key.
 */
export const NATIVE_PROVIDERS: readonly CatalogProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'chat-completion',
    category: 'frontier',
    nativeRouted: true,
    secretKey: 'api_key_openai',
    imageCapable: true,
    defaultModels: [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o4-mini',
      'o3',
      'o3-mini',
      'o1',
      'o1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'chatgpt-4o-latest',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
    ],
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    description: 'GPT-4.1, o3/o4, GPT-4o, and the rest of the OpenAI lineup.',
  },
  {
    id: 'claude',
    name: 'Claude',
    kind: 'chat-completion',
    category: 'frontier',
    nativeRouted: true,
    secretKey: 'api_key_claude',
    defaultModels: [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5-20251001',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ],
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    description: "Anthropic's Claude family — Opus, Sonnet, Haiku.",
  },
  {
    id: 'makersuite',
    name: 'Google Gemini',
    kind: 'chat-completion',
    category: 'frontier',
    nativeRouted: true,
    secretKey: 'api_key_makersuite',
    defaultModels: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
    ],
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    description: "Google's Gemini models via AI Studio.",
  },
  {
    id: 'vertexai',
    name: 'Vertex AI',
    kind: 'chat-completion',
    category: 'frontier',
    nativeRouted: true,
    secretKey: 'api_key_vertexai',
    defaultModels: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
    docsUrl: 'https://cloud.google.com/vertex-ai/docs',
    description: 'Google Cloud Vertex AI — Gemini with GCP auth.',
  },
  {
    id: 'mistralai',
    name: 'Mistral AI',
    kind: 'chat-completion',
    category: 'specialty',
    nativeRouted: true,
    secretKey: 'api_key_mistralai',
    defaultModels: [
      'mistral-large-latest',
      'pixtral-large-latest',
      'mistral-saba-latest',
      'mistral-small-latest',
      'mistral-nemo',
      'codestral-latest',
    ],
    docsUrl: 'https://docs.mistral.ai/api/',
    description: "Mistral's hosted models — Large, Pixtral, Saba, Small, Nemo, Codestral.",
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'chat-completion',
    category: 'specialty',
    nativeRouted: true,
    secretKey: 'api_key_groq',
    defaultModels: [
      'llama-3.3-70b-versatile',
      'llama-3.3-70b-specdec',
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen-qwq-32b',
      'gemma2-9b-it',
      'llama3-70b-8192',
      'llama3-8b-8192',
      'mixtral-8x7b-32768',
    ],
    docsUrl: 'https://console.groq.com/docs/api-reference',
    description: 'Ultra-fast LPU inference for Llama, Qwen, Gemma, and more.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'chat-completion',
    category: 'open',
    nativeRouted: true,
    secretKey: 'api_key_openrouter',
    defaultModels: [
      'openai/gpt-4.1',
      'openai/o3',
      'openai/gpt-4o',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-6',
      'anthropic/claude-sonnet-4-6',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat-v3-0324',
      'x-ai/grok-3',
      'mistralai/mistral-large',
    ],
    docsUrl: 'https://openrouter.ai/docs',
    description: 'One key, 300+ models from every major provider.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'chat-completion',
    category: 'specialty',
    nativeRouted: true,
    secretKey: 'api_key_deepseek',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    docsUrl: 'https://api-docs.deepseek.com/',
    description: 'DeepSeek V3 + R1 reasoner, direct from the source.',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    kind: 'chat-completion',
    category: 'specialty',
    nativeRouted: true,
    secretKey: 'api_key_cohere',
    defaultModels: [
      'command-r-plus',
      'command-r-plus-08-2024',
      'command-r',
      'command-r-08-2024',
      'command-r-03-2024',
    ],
    docsUrl: 'https://docs.cohere.com/reference/chat',
    description: 'Command R / R+ models with built-in retrieval.',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    kind: 'chat-completion',
    category: 'specialty',
    nativeRouted: true,
    secretKey: 'api_key_perplexity',
    defaultModels: [
      'sonar-reasoning-pro',
      'sonar-reasoning',
      'sonar-pro',
      'sonar',
      'sonar-deep-research',
    ],
    docsUrl: 'https://docs.perplexity.ai/',
    description: 'Sonar models with live web search and reasoning built in.',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    kind: 'chat-completion',
    category: 'frontier',
    nativeRouted: true,
    secretKey: 'api_key_xai',
    defaultModels: [
      'grok-3',
      'grok-3-fast',
      'grok-3-mini',
      'grok-3-mini-fast',
      'grok-2-1212',
      'grok-2-vision-1212',
    ],
    docsUrl: 'https://docs.x.ai/',
    description: "xAI's Grok 3 family — standard and fast variants.",
  },
  {
    id: 'ai21',
    name: 'AI21',
    kind: 'chat-completion',
    category: 'specialty',
    nativeRouted: true,
    secretKey: 'api_key_ai21',
    defaultModels: ['jamba-1.5-large', 'jamba-1.5-mini'],
    docsUrl: 'https://docs.ai21.com/',
    description: 'Jamba hybrid SSM-Transformer models.',
  },
  {
    id: '01ai',
    name: '01.AI (Yi)',
    kind: 'chat-completion',
    category: 'open',
    nativeRouted: true,
    secretKey: 'api_key_01ai',
    defaultModels: ['yi-large', 'yi-medium', 'yi-spark'],
    docsUrl: 'https://platform.01.ai/docs',
    description: 'Yi models from 01.AI — strong at long context.',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    kind: 'chat-completion',
    category: 'open',
    nativeRouted: true,
    secretKey: 'api_key_moonshot',
    defaultModels: ['kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    docsUrl: 'https://platform.moonshot.ai/docs',
    description: 'Kimi K2 and Moonshot V1 long-context models.',
  },
  {
    id: 'zhipu',
    name: 'Zhipu (GLM)',
    kind: 'chat-completion',
    category: 'open',
    nativeRouted: true,
    secretKey: 'api_key_zhipu',
    defaultModels: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    docsUrl: 'https://open.bigmodel.cn/dev/api',
    description: 'GLM-4 family from Zhipu AI.',
  },
  {
    id: 'nanogpt',
    name: 'NanoGPT',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: true,
    secretKey: 'api_key_nanogpt',
    defaultModels: [
      'gpt-4o',
      'chatgpt-4o-latest',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
    ],
    docsUrl: 'https://nano-gpt.com/api',
    description: 'Pay-as-you-go crypto-friendly proxy for many models.',
  },
  {
    id: 'blockentropy',
    name: 'Block Entropy',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: true,
    secretKey: 'api_key_blockentropy',
    defaultModels: ['be-70b-4k-base', 'be-8b-4k-base'],
    docsUrl: 'https://blockentropy.ai/',
    description: 'Uncensored hosted open-source models.',
  },
  {
    id: 'pollinations',
    name: 'Pollinations',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: true,
    secretKey: 'api_key_pollinations',
    defaultModels: ['openai', 'mistral', 'deepseek'],
    docsUrl: 'https://pollinations.ai/',
    description: 'Free AI text + image inference gateway.',
  },
  {
    id: 'aimlapi',
    name: 'AI/ML API',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: true,
    secretKey: 'api_key_aimlapi',
    defaultModels: [
      'gpt-4o',
      'gpt-4.1',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022',
      'gemini-2.5-pro',
      'deepseek-chat',
      'deepseek/deepseek-r1',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    ],
    docsUrl: 'https://docs.aimlapi.com/',
    description: '200+ models through a single OpenAI-compatible key.',
  },
  {
    id: 'electronhub',
    name: 'Electron Hub',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: true,
    secretKey: 'api_key_electronhub',
    defaultModels: [
      'gpt-4o',
      'gpt-4.1',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'gemini-2.5-pro',
      'llama-3.3-70b',
      'deepseek-r1',
    ],
    docsUrl: 'https://www.electronhub.top/',
    description: 'Aggregated proxy for frontier and open models.',
  },
];

/**
 * OpenAI-compatible aggregators. Route via chat_completion_source: 'custom'.
 * These appear in the catalog as one-click installs that prefill the custom
 * endpoint fields with a known baseUrl + seed model list.
 */
export const OPENAI_COMPAT_PROVIDERS: readonly CatalogProvider[] = [
  {
    id: 'togetherai',
    name: 'Together AI',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.together.xyz/v1',
    secretKey: 'api_key_custom_togetherai',
    defaultModels: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'mistralai/Mistral-7B-Instruct-v0.3',
      'google/gemma-2-27b-it',
    ],
    docsUrl: 'https://docs.together.ai/',
    description: 'Hosted Llama, DeepSeek, Qwen, Mistral, and more.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    secretKey: 'api_key_custom_fireworks',
    defaultModels: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/deepseek-r1',
      'accounts/fireworks/models/qwen2p5-72b-instruct',
      'accounts/fireworks/models/mixtral-8x22b-instruct',
    ],
    docsUrl: 'https://docs.fireworks.ai/',
    description: 'Fast serverless hosting for open-source models.',
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    secretKey: 'api_key_custom_hyperbolic',
    defaultModels: [
      'meta-llama/Meta-Llama-3.1-405B-Instruct',
      'meta-llama/Llama-3.3-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
    ],
    docsUrl: 'https://docs.hyperbolic.xyz/',
    description: 'Cheap inference on large open-source models.',
  },
  {
    id: 'chutes',
    name: 'Chutes',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://llm.chutes.ai/v1',
    secretKey: 'api_key_custom_chutes',
    defaultModels: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/Llama-3.1-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
    docsUrl: 'https://chutes.ai/',
    description: 'Decentralized inference marketplace.',
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.sambanova.ai/v1',
    secretKey: 'api_key_custom_sambanova',
    defaultModels: [
      'Meta-Llama-3.3-70B-Instruct',
      'Meta-Llama-3.1-405B-Instruct',
      'Meta-Llama-3.1-70B-Instruct',
      'DeepSeek-R1',
      'DeepSeek-R1-Distill-Llama-70B',
      'Qwen2.5-72B-Instruct',
      'QwQ-32B',
    ],
    docsUrl: 'https://docs.sambanova.ai/',
    description: 'Extremely fast inference on RDU chips.',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.cerebras.ai/v1',
    secretKey: 'api_key_custom_cerebras',
    defaultModels: [
      'llama-3.3-70b',
      'llama-3.1-8b',
      'deepseek-r1-distill-llama-70b',
      'qwen-3-32b',
    ],
    docsUrl: 'https://inference-docs.cerebras.ai/',
    description: 'Wafer-scale inference at thousands of tokens/sec.',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    secretKey: 'api_key_custom_deepinfra',
    defaultModels: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/Meta-Llama-3.1-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'mistralai/Mistral-7B-Instruct-v0.3',
      'google/gemma-2-27b-it',
    ],
    docsUrl: 'https://deepinfra.com/docs',
    description: 'Cheap hosted inference for open-source models.',
  },
  {
    id: 'infermatic',
    name: 'InfermaticAI',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.totalgpt.ai/v1',
    secretKey: 'api_key_custom_infermatic',
    defaultModels: ['Infermatic-Llama-3.1-70B', 'Infermatic-Mixtral-8x22B'],
    docsUrl: 'https://infermatic.ai/',
    description: 'Subscription-priced OpenAI-compat proxy.',
  },
  {
    id: 'featherless',
    name: 'Featherless',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api.featherless.ai/v1',
    secretKey: 'api_key_custom_featherless',
    defaultModels: ['meta-llama/Meta-Llama-3.1-70B-Instruct'],
    docsUrl: 'https://featherless.ai/',
    description: 'Unlimited inference on 3000+ open models.',
  },
  {
    id: 'mancer',
    name: 'Mancer',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://neuro.mancer.tech/oai/v1',
    secretKey: 'api_key_custom_mancer',
    defaultModels: ['mancer/weaver', 'mythomax-l2-13b'],
    docsUrl: 'https://mancer.tech/docs',
    description: 'Uncensored roleplay-oriented hosted models.',
  },
  {
    id: 'dreamgen',
    name: 'DreamGen',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://dreamgen.com/api/openai/v1',
    secretKey: 'api_key_custom_dreamgen',
    defaultModels: ['lucid-v1-extended', 'opus-v1-xl'],
    docsUrl: 'https://dreamgen.com/docs',
    description: 'Hosted Opus/Lucid models tuned for story writing.',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Inference',
    kind: 'chat-completion',
    category: 'aggregator',
    nativeRouted: false,
    baseUrl: 'https://api-inference.huggingface.co/v1',
    secretKey: 'api_key_custom_huggingface',
    defaultModels: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'meta-llama/Meta-Llama-3.1-8B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'mistralai/Mistral-7B-Instruct-v0.3',
      'HuggingFaceH4/zephyr-7b-beta',
    ],
    docsUrl: 'https://huggingface.co/docs/api-inference',
    description: 'Serverless Inference API for Hugging Face models.',
  },
];

/**
 * Local / self-hosted servers. Same routing as OpenAI-compat (custom source),
 * but grouped separately in the UI since they require a locally running server.
 */
export const LOCAL_PROVIDERS: readonly CatalogProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:11434/v1',
    secretKey: 'api_key_custom_ollama',
    defaultModels: [
      'llama3.3',
      'llama3.2',
      'llama3.1',
      'qwen2.5',
      'qwen2.5:32b',
      'deepseek-r1',
      'gemma3',
      'mistral',
      'phi4',
      'phi3',
    ],
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    description: 'Run open-source models locally. Zero config.',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:1234/v1',
    secretKey: 'api_key_custom_lmstudio',
    defaultModels: [],
    docsUrl: 'https://lmstudio.ai/docs',
    description: 'GUI desktop app for running local LLMs.',
  },
  {
    id: 'koboldcpp',
    name: 'KoboldCpp',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:5001/v1',
    secretKey: 'api_key_custom_koboldcpp',
    defaultModels: [],
    docsUrl: 'https://github.com/LostRuins/koboldcpp/wiki',
    description: 'Single-file llama.cpp runner with OpenAI-compat API.',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp Server',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:8080/v1',
    secretKey: 'api_key_custom_llamacpp',
    defaultModels: [],
    docsUrl: 'https://github.com/ggerganov/llama.cpp/tree/master/examples/server',
    description: 'Official llama.cpp HTTP server.',
  },
  {
    id: 'tabbyapi',
    name: 'TabbyAPI',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:5000/v1',
    secretKey: 'api_key_custom_tabbyapi',
    defaultModels: [],
    docsUrl: 'https://github.com/theroyallab/tabbyAPI',
    description: 'ExLlamaV2 OpenAI-compatible server.',
  },
  {
    id: 'ooba',
    name: 'Text Generation WebUI',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:5000/v1',
    secretKey: 'api_key_custom_ooba',
    defaultModels: [],
    docsUrl: 'https://github.com/oobabooga/text-generation-webui',
    description: "Oobabooga's all-in-one local LLM UI.",
  },
  {
    id: 'aphrodite',
    name: 'Aphrodite',
    kind: 'chat-completion',
    category: 'local',
    nativeRouted: false,
    baseUrl: 'http://localhost:2242/v1',
    secretKey: 'api_key_custom_aphrodite',
    defaultModels: [],
    docsUrl: 'https://github.com/PygmalionAI/aphrodite-engine',
    description: 'vLLM-forked serving engine for open models.',
  },
];

/** The complete built-in catalog. */
export const BUILTIN_CATALOG: readonly CatalogProvider[] = [
  ...NATIVE_PROVIDERS,
  ...OPENAI_COMPAT_PROVIDERS,
  ...LOCAL_PROVIDERS,
];

// ---------------------------------------------------------------------------
// User-added providers
// ---------------------------------------------------------------------------

/**
 * A user-added provider. Structurally the same as a CatalogProvider, but
 * always non-native-routed (we can't add new native sources without changing
 * the backend) and carries a timestamp so the catalog page can sort them.
 */
export interface UserProvider extends CatalogProvider {
  nativeRouted: false;
  baseUrl: string;
  createdAt: number;
  /** Optional — set by AI extraction to record the docs page used. */
  sourceUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getCatalogProvider(id: string): CatalogProvider | undefined {
  return BUILTIN_CATALOG.find((p) => p.id === id);
}

export function isNativeProvider(id: string): boolean {
  return NATIVE_PROVIDERS.some((p) => p.id === id);
}

/**
 * Whether a chat provider can also generate images through a wired route in
 * this app. Drives the "use my main provider" affordance and the text-only
 * warning in the image-generation settings. Unknown ids → false (safe: shows
 * the warning rather than falsely promising image support).
 */
export function isImageCapableProvider(id: string): boolean {
  return !!getCatalogProvider(id)?.imageCapable;
}

/** Build a stable secret key slot for a user provider. */
export function userProviderSecretKey(id: string): string {
  return `api_key_custom_${id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}`;
}

/** Generate a URL-safe id from a provider display name. */
export function slugifyProviderName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    || `provider-${Date.now()}`;
}
