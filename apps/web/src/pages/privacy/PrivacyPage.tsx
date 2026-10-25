import { Mail } from 'lucide-react';
import type { ReactNode } from 'react';

const CONTACT = 'acz882024@gmail.com';
const UPDATED = 'October 25, 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-6 text-gray-700">{children}</div>
    </section>
  );
}

const link = 'text-blue-700 underline';

/** The privacy policy (/privacy): public, no sign-in needed. Linked from the login page and Google's consent screen. */
export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#f6f8fc] px-4 py-10 text-[#1f1f1f]">
      <article className="mx-auto max-w-3xl rounded-2xl bg-white p-8 shadow-sm">
        <a href="/" className="flex items-center gap-2 text-gray-700">
          <Mail className="h-6 w-6 text-blue-600" />
          <span className="font-medium">AI Email Agent</span>
        </a>
        <h1 className="mt-6 text-2xl font-medium">Privacy Policy</h1>
        <p className="mt-1 text-sm text-gray-500">Last updated {UPDATED}</p>
        <p className="mt-4 text-sm leading-6 text-gray-700">
          AI Email Agent is an assistant for your Gmail: it lets you search and organize your mail,
          ask an AI assistant about it, and set up automations (for example, labeling or archiving
          certain emails). This policy explains what data the app accesses, how it is used and
          stored, and how you can delete it.
        </p>

        <Section title="Google data the app accesses">
          <p>When you sign in with Google, you grant the app these permissions:</p>
          <ul className="list-disc space-y-1 pl-6">
            <li>
              <b>Basic profile</b> (name and email address): to identify your account.
            </li>
            <li>
              <b>Gmail</b> (read, compose, send and modify): to show your mail, search it, mark it
              read or starred, label and archive it, and send the emails and replies you write or
              approve. The app keeps a synced copy of your mail from the last year so search and AI
              features work quickly. It never permanently deletes your email.
            </li>
            <li>
              <b>Google Tasks</b>: to create and update to-dos you add from emails.
            </li>
            <li>
              <b>Google Drive, Sheets and Docs</b>: only for files the app creates for you (for
              example, a spreadsheet of your orders). The app cannot see other files in your Drive.
            </li>
          </ul>
        </Section>

        <Section title="How your data is used">
          <p>
            Your data is used only to provide the features you use in the app. When you use AI
            features (the assistant, AI search, automations), the relevant email content, your
            messages to the assistant and files you attach are sent to the Google Gemini API to
            generate answers, summaries, search results and automation decisions.
          </p>
          <p>
            We do not sell your data, use it for advertising, or use it to develop, improve or train
            generalized AI or machine learning models. No person reads your email unless you ask for
            help with a specific problem, it is needed for security, or the law requires it.
          </p>
        </Section>

        <Section title="Limited Use">
          <p>
            AI Email Agent&rsquo;s use and transfer of information received from Google APIs to any
            other app will adhere to the{' '}
            <a
              className={link}
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </Section>

        <Section title="Where data is stored and who processes it">
          <p>
            Your synced mail, search index, chats, assistant memory, automations and uploaded files
            are stored in a database hosted by Supabase and on a server hosted by Amazon Web
            Services, both in the United States. Data is encrypted in transit (HTTPS), and the
            Google access token that lets the app work on your behalf is stored encrypted.
          </p>
          <p>
            Data is shared only with the service providers needed to run the app (Supabase, Amazon
            Web Services and the Google Gemini API), or when required by law.
          </p>
        </Section>

        <Section title="Keeping and deleting your data">
          <p>
            Your data is kept while you have an account. Signing out does not delete it: the app
            keeps your mail in sync and runs your automations until you delete your account.
          </p>
          <p>
            To delete everything, open the account menu (your picture, top right) and choose{' '}
            <b>Delete account</b>. This revokes the app&rsquo;s access to your Google account and
            erases all data the app keeps for you. Your Gmail, Google Tasks and files in your Drive
            are not affected. You can also remove the app&rsquo;s access at any time from your{' '}
            <a
              className={link}
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              Google Account permissions
            </a>
            , or email us to have your data deleted.
          </p>
        </Section>

        <Section title="Children">
          <p>The app is not intended for children under 13.</p>
        </Section>

        <Section title="Changes and contact">
          <p>
            If this policy changes, the date above will be updated. Questions or requests:{' '}
            <a className={link} href={`mailto:${CONTACT}`}>
              {CONTACT}
            </a>
            .
          </p>
        </Section>
      </article>
    </div>
  );
}
