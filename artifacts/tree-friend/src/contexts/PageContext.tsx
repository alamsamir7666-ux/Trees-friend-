import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";

type PageContextType = {
  pageReady: boolean;
  setPageReady: (ready: boolean) => void;
};

const PageContext = createContext<PageContextType>({
  pageReady: true,
  setPageReady: () => {},
});

export function PageProvider({ children }: { children: ReactNode }) {
  const [pageReady, setPageReady] = useState(true);
  const [location] = useLocation();

  useEffect(() => {
    setPageReady(true);
  }, [location]);

  return (
    <PageContext.Provider value={{ pageReady, setPageReady }}>
      {children}
    </PageContext.Provider>
  );
}

export function usePageContext() {
  return useContext(PageContext);
}
