import React from 'react';

interface WebBookErrorBoundaryProps {
  children: React.ReactNode;
}

interface WebBookErrorBoundaryState {
  hasError: boolean;
}

export class WebBookErrorBoundary extends React.Component<WebBookErrorBoundaryProps, WebBookErrorBoundaryState> {
  declare props: WebBookErrorBoundaryProps;
  declare state: WebBookErrorBoundaryState;

  constructor(props: WebBookErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
    };
  }

  static getDerivedStateFromError(): WebBookErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: unknown) {
    console.error('WebBook rendering failed', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full bg-white border border-red-300 p-8 text-red-900 shadow-[8px_8px_0px_0px_rgba(127,29,29,0.15)]">
          <h3 className="text-lg font-semibold mb-3">The WebBook could not be rendered safely.</h3>
          <p className="text-sm leading-relaxed">
            The generated chapter structure appears malformed or incomplete. The rest of the app is still running,
            so you can try the search again or export the current result for inspection.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
