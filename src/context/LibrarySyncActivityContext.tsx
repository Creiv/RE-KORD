/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type LibrarySyncLabelParams = Record<string, string | number>;

type Activity = {
  id: number;
  labelKey: string;
  labelParams?: LibrarySyncLabelParams;
};

type LibrarySyncActivityContextValue = {
  busy: boolean;
  primaryActivity: Activity | null;
  beginActivity: (
    labelKey: string,
    labelParams?: LibrarySyncLabelParams
  ) => () => void;
};

const LibrarySyncActivityContext =
  createContext<LibrarySyncActivityContextValue | null>(null);

export function LibrarySyncActivityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const idRef = useRef(0);

  const beginActivity = useCallback(
    (labelKey: string, labelParams?: LibrarySyncLabelParams) => {
      const id = ++idRef.current;
      setActivities((prev) => [...prev, { id, labelKey, labelParams }]);
      return () => {
        setActivities((prev) => prev.filter((item) => item.id !== id));
      };
    },
    []
  );

  const busy = activities.length > 0;
  const primaryActivity = activities[activities.length - 1] ?? null;

  const value = useMemo(
    () => ({ beginActivity, busy, primaryActivity }),
    [beginActivity, busy, primaryActivity]
  );

  return (
    <LibrarySyncActivityContext.Provider value={value}>
      {children}
    </LibrarySyncActivityContext.Provider>
  );
}

export function useLibrarySyncActivity() {
  const ctx = useContext(LibrarySyncActivityContext);
  if (!ctx) {
    throw new Error(
      "useLibrarySyncActivity: missing LibrarySyncActivityProvider"
    );
  }
  return ctx;
}

/** Per provider opzionale (test). */
export function useLibrarySyncActivityOptional() {
  return useContext(LibrarySyncActivityContext);
}

export async function runWithLibrarySyncActivity<T>(
  beginActivity: LibrarySyncActivityContextValue["beginActivity"],
  labelKey: string,
  fn: () => Promise<T>,
  labelParams?: LibrarySyncLabelParams
): Promise<T> {
  const end = beginActivity(labelKey, labelParams);
  try {
    return await fn();
  } finally {
    end();
  }
}
