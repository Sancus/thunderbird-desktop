/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_BASE_SRC_COPYMESSAGESTREAMLISTENER_H_
#define COMM_MAILNEWS_BASE_SRC_COPYMESSAGESTREAMLISTENER_H_

#include <functional>

#include "nsIStreamListener.h"
#include "nsICopyMessageListener.h"
#include "nsCOMPtr.h"

class CopyMessageStreamListener : public nsIStreamListener,
                                  public nsICopyMessageListener {
 public:
  // If supplied, endCopy replaces the destination EndCopy(bool) callback and
  // receives the first failure. Move completion still uses EndMove(bool).
  CopyMessageStreamListener(nsICopyMessageListener* destination, bool isMove,
                            std::function<nsresult(nsresult)> endCopy = {});

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSICOPYMESSAGELISTENER
  NS_DECL_NSIREQUESTOBSERVER
  NS_DECL_NSISTREAMLISTENER

 protected:
  virtual ~CopyMessageStreamListener();

 private:
  nsresult RememberResult(nsresult status);

  nsCOMPtr<nsICopyMessageListener> mDestination;
  std::function<nsresult(nsresult)> mEndCopy;
  nsresult mStatus = NS_OK;
  bool mIsMove;
};

#endif  // COMM_MAILNEWS_BASE_SRC_COPYMESSAGESTREAMLISTENER_H_
