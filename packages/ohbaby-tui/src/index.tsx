import { render, Text, type Instance } from 'ink';
import type { ReactElement } from 'react';
import type { UiBackendClient } from 'ohbaby-sdk';

export interface TerminalUiOptions {
  readonly client: UiBackendClient;
}

export function OhbabyTerminalApp({ client }: TerminalUiOptions): ReactElement {
  void client;

  return <Text>ohbaby terminal UI skeleton</Text>;
}

export function renderTerminalUi(options: TerminalUiOptions): Instance {
  return render(<OhbabyTerminalApp client={options.client} />);
}

