import { createBrowserHistory, History } from 'history';
import { createStore, applyMiddleware, compose, combineReducers, Reducer } from 'redux';
import { routerMiddleware, connectRouter } from 'connected-react-router';
import thunk, { ThunkMiddleware } from 'redux-thunk';
import createDebounce from 'redux-debounced';
import logger from 'redux-logger';
import autoMergeLevel2 from 'redux-persist/lib/stateReconciler/autoMergeLevel2';
import { persistReducer } from 'redux-persist'
import storage from 'redux-persist/lib/storage'
import { ILoadedReducers, ILoadedState, ThunkStore } from './types/index.d';
import persistStore from 'redux-persist/es/persistStore';

export const history: History<unknown> = createBrowserHistory();

const initialRootState = {} as ISharedState;
const rootReducer: Reducer<ILoadedState, ISharedActions> = (state = initialRootState) => {
  return state as ISharedState;
}

export let initialReducers: ILoadedReducers = {
  root: rootReducer,
  router: connectRouter(history)
};

const createRootReducer = (): Reducer<ILoadedState, ISharedActions> => {
  return combineReducers(initialReducers);
};

const persistConfig = {
  key: 'root',
  storage,
  stateReconciler: autoMergeLevel2
}

const persistedReducer = persistReducer(persistConfig, createRootReducer);

export const store = createStore(
  persistedReducer,
  initialRootState,
  compose(
    applyMiddleware(
      createDebounce(),
      routerMiddleware(history),
      thunk as ThunkMiddleware<ISharedState, ISharedActions>,
      logger
    )
  )
) as ThunkStore;

export const persistor = persistStore(store);

export const addReducer = (reducers: ILoadedReducers): void => {
  initialReducers = { ...initialReducers, ...reducers };
  store.replaceReducer(createRootReducer());
}