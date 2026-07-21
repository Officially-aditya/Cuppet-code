import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'
import type { CredentialsStore } from '../auth/providerAuth.js'

export type ModelRequest = {
  systemPrompt: string
  userPrompt: string
  model?: string
  useSecondary?: boolean
}

export type ModelResponse = {
  text: string
  inputTokens: number
  outputTokens: number
}

export class ModelRouter {
  private creds: CredentialsStore

  constructor(creds: CredentialsStore) {
    this.creds = creds
  }

  updateCredentials(creds: CredentialsStore): void {
    this.creds = creds
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const provider = this.creds.activeProvider
    const model = req.model ?? (req.useSecondary ? this.creds.secondaryModel : this.creds.primaryModel)

    if (provider === 'google') {
      return this.generateGoogle(req, model)
    } else if (provider === 'anthropic') {
      return this.generateAnthropic(req, model)
    } else if (provider === 'openai') {
      return this.generateOpenAI(req, model)
    }

    throw new Error(`Unsupported provider: ${provider}`)
  }

  private async generateGoogle(req: ModelRequest, model: string): Promise<ModelResponse> {
    const apiKey = this.creds.googleApiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (!apiKey) throw new Error('Google API key is missing. Run /login to configure.')

    const ai = new GoogleGenAI({ apiKey })
    const response = await ai.models.generateContent({
      model,
      contents: `${req.systemPrompt}\n\nUser: ${req.userPrompt}`,
    })

    const text = response.text ?? ''
    return {
      text,
      inputTokens: Math.ceil((req.systemPrompt.length + req.userPrompt.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
    }
  }

  private async generateAnthropic(req: ModelRequest, model: string): Promise<ModelResponse> {
    const apiKey = this.creds.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Anthropic API key is missing. Run /login to configure.')

    const anthropic = new Anthropic({ apiKey })
    const response = await anthropic.messages.create({
      model,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      max_tokens: 4096,
    })

    const text = response.content.map(c => c.type === 'text' ? c.text : '').join('')
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }

  private async generateOpenAI(req: ModelRequest, model: string): Promise<ModelResponse> {
    const apiKey = this.creds.openaiApiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OpenAI API key is missing. Run /login to configure.')

    const openai = new OpenAI({ apiKey })
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
    })

    const text = response.choices[0]?.message?.content ?? ''
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? Math.ceil(req.userPrompt.length / 4),
      outputTokens: response.usage?.completion_tokens ?? Math.ceil(text.length / 4),
    }
  }
}
